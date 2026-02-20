import express from 'express'
import axios from 'axios'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { apiKeyAuth } from '../middleware/api-key-auth.js'
import { requireMenu } from '../middleware/rbac.js'
import { syncAccountUserCount, syncAccountInviteCount, fetchOpenAiAccountInfo, selectQuotaSourceFromAccounts, AccountSyncError, deleteAccountUser, inviteAccountUser, deleteAccountInvite } from '../services/account-sync.js'

const router = express.Router()
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  if (['1', 'true', 'yes'].includes(raw)) return true
  if (['0', 'false', 'no'].includes(raw)) return false
  return null
}

const EXPIRE_AT_REGEX = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/

const formatExpireAt = (date) => {
  const pad = (value) => String(value).padStart(2, '0')
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date)
    const get = (type) => parts.find(p => p.type === type)?.value || ''
    return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
  } catch {
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }
}

const normalizeExpireAt = (value) => {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (EXPIRE_AT_REGEX.test(raw)) return raw

  // 支持 YYYY-MM-DD HH:mm:ss 或 YYYY/MM/DDTHH:mm:ss 格式
  const match = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (match) {
    const seconds = match[6] || '00'
    return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}:${seconds}`
  }

  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && asNumber > 0) {
    const date = new Date(asNumber)
    if (!Number.isNaN(date.getTime())) {
      return formatExpireAt(date)
    }
  }

  return null
}

const collectEmails = (payload) => {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.emails)) return payload.emails
  if (typeof payload.emails === 'string') return [payload.emails]
  if (typeof payload.email === 'string') return [payload.email]
  return []
}

const CHECK_STATUS_ALLOWED_RANGE_DAYS = new Set([7, 15, 30])
const MAX_CHECK_ACCOUNTS = 300
const CHECK_STATUS_CONCURRENCY = 3

const ACCOUNT_TYPE_VALUES = new Set(['team', 'personal', 'unknown'])
const GPT_ACCOUNT_SELECT_COLUMNS = `
  id,
  email,
  token,
  refresh_token,
  user_count,
  invite_count,
  chatgpt_account_id,
  oai_device_id,
  expire_at,
  is_open,
  COALESCE(is_banned, 0) AS is_banned,
  created_at,
  updated_at,
  COALESCE(account_type, 'unknown') AS account_type,
  plan_type
`

const normalizePlanType = (value) => {
  if (value == null) return null
  const normalized = String(value).trim().toLowerCase()
  return normalized || null
}

const inferAccountTypeFromPlanType = (planType) => {
  const normalizedPlanType = normalizePlanType(planType)
  if (!normalizedPlanType) return 'unknown'
  if (normalizedPlanType === 'team') return 'team'
  return 'personal'
}

const normalizeAccountType = (value, fallback = 'unknown') => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (ACCOUNT_TYPE_VALUES.has(normalized)) return normalized
  return fallback
}

const normalizeStoredAccountType = (accountType, planType) => {
  const normalizedType = normalizeAccountType(accountType, '')
  if (normalizedType) return normalizedType
  return inferAccountTypeFromPlanType(planType)
}

const normalizeQuotaStatus = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'normal' || normalized === 'expired' || normalized === 'unknown') return normalized
  return 'unknown'
}

const isoToStoredExpireAt = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) return null
  return formatExpireAt(new Date(parsed))
}

const mapGptAccountRow = (row) => ({
  id: Number(row[0]),
  email: String(row[1] || ''),
  token: row[2] || '',
  refreshToken: row[3] || null,
  userCount: Number(row[4] || 0),
  inviteCount: Number(row[5] || 0),
  chatgptAccountId: row[6] || '',
  oaiDeviceId: row[7] || '',
  expireAt: row[8] || null,
  isOpen: Boolean(row[9]),
  isDemoted: false,
  isBanned: Boolean(row[10]),
  createdAt: row[11],
  updatedAt: row[12],
  accountType: normalizeStoredAccountType(row[13], row[14]),
  planType: normalizePlanType(row[14])
})

const fetchGptAccountById = async (db, accountId) => {
  const result = db.exec(
    `SELECT ${GPT_ACCOUNT_SELECT_COLUMNS} FROM gpt_accounts WHERE id = ?`,
    [accountId]
  )

  const row = result[0]?.values?.[0]
  return row ? mapGptAccountRow(row) : null
}

const getQuotaReason = (quota) => {
  if (!quota) return '未返回额度信息'

  const status = normalizeQuotaStatus(quota.status)
  if (status === 'normal') return null

  if (status === 'expired') {
    if (quota.expiresAt) return '额度已过期'
    return '未检测到有效订阅'
  }

  return '额度状态未知'
}

const pickAccountFromCheckResult = (account, checkedAccounts, quota) => {
  const list = Array.isArray(checkedAccounts) ? checkedAccounts : []
  const currentId = String(account?.chatgptAccountId || '').trim()
  const quotaSourceId = String(quota?.sourceAccountId || '').trim()

  if (currentId) {
    const matchedCurrent = list.find(item => String(item?.accountId || '').trim() === currentId)
    if (matchedCurrent) return matchedCurrent
  }
  if (quotaSourceId) {
    const matchedQuota = list.find(item => String(item?.accountId || '').trim() === quotaSourceId)
    if (matchedQuota) return matchedQuota
  }
  if (list.length === 1) return list[0]
  return null
}

const persistAccountProfileFromCheckResult = async (db, account, checkedAccounts, quota) => {
  if (!account?.id) return account

  const matched = pickAccountFromCheckResult(account, checkedAccounts, quota)
  const normalizedPlanType = normalizePlanType(
    matched?.planType ?? quota?.planType ?? account.planType ?? null
  )
  const normalizedAccountType = normalizeStoredAccountType(
    matched?.accountType ?? quota?.accountType ?? account.accountType ?? 'unknown',
    normalizedPlanType
  )
  const normalizedChatgptAccountId = String(
    matched?.accountId ?? quota?.sourceAccountId ?? account.chatgptAccountId ?? ''
  ).trim()
  const normalizedExpireAt = quota?.expiresAt ? isoToStoredExpireAt(quota.expiresAt) : null

  const hasAccountTypeChanged = normalizedAccountType !== normalizeStoredAccountType(account.accountType, account.planType)
  const hasPlanTypeChanged = normalizedPlanType !== normalizePlanType(account.planType)
  const hasAccountIdChanged = normalizedChatgptAccountId && normalizedChatgptAccountId !== String(account.chatgptAccountId || '').trim()
  const hasExpireAtChanged = normalizedExpireAt && normalizedExpireAt !== String(account.expireAt || '')

  if (!hasAccountTypeChanged && !hasPlanTypeChanged && !hasAccountIdChanged && !hasExpireAtChanged) {
    return account
  }

  db.run(
    `
      UPDATE gpt_accounts
      SET account_type = ?,
          plan_type = ?,
          chatgpt_account_id = CASE WHEN ? = 1 THEN ? ELSE chatgpt_account_id END,
          expire_at = CASE WHEN ? = 1 THEN ? ELSE expire_at END,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [
      normalizedAccountType,
      normalizedPlanType,
      hasAccountIdChanged ? 1 : 0,
      normalizedChatgptAccountId || null,
      hasExpireAtChanged ? 1 : 0,
      normalizedExpireAt,
      account.id
    ]
  )
  await saveDatabase()
  return (await fetchGptAccountById(db, account.id)) || {
    ...account,
    accountType: normalizedAccountType,
    planType: normalizedPlanType,
    chatgptAccountId: normalizedChatgptAccountId || account.chatgptAccountId,
    expireAt: normalizedExpireAt || account.expireAt
  }
}

const mapWithConcurrency = async (items, concurrency, fn) => {
  const list = Array.isArray(items) ? items : []
  const limit = Math.max(1, Number(concurrency) || 1)
  if (!list.length) return []

  const results = new Array(list.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, list.length) }).map(async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const index = cursor++
      if (index >= list.length) break
      results[index] = await fn(list[index], index)
    }
  })

  await Promise.all(workers)
  return results
}

const eachWithConcurrency = async (items, concurrency, fn) => {
  const list = Array.isArray(items) ? items : []
  const limit = Math.max(1, Number(concurrency) || 1)
  if (!list.length) return

  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, list.length) }).map(async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const index = cursor++
      if (index >= list.length) break
      await fn(list[index], index)
    }
  })

  await Promise.all(workers)
}

const refreshAccessTokenWithRefreshToken = async (refreshToken) => {
  const normalized = String(refreshToken || '').trim()
  if (!normalized) {
    throw new AccountSyncError('该账号未配置 refresh token', 400)
  }

  const requestData = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OPENAI_CLIENT_ID,
    refresh_token: normalized,
    scope: 'openid profile email'
  }).toString()

  const requestOptions = {
    method: 'POST',
    url: 'https://auth.openai.com/oauth/token',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': requestData.length
    },
    data: requestData,
    timeout: 60000
  }

  try {
    const response = await axios(requestOptions)
    if (response.status !== 200 || !response.data?.access_token) {
      throw new AccountSyncError('刷新 token 失败，未返回有效凭证', 502)
    }

    const resultData = response.data
    return {
      accessToken: resultData.access_token,
      refreshToken: resultData.refresh_token || normalized,
      idToken: resultData.id_token,
      expiresIn: resultData.expires_in || 3600
    }
  } catch (error) {
    if (error?.response) {
      const message =
        error.response.data?.error?.message ||
        error.response.data?.error_description ||
        error.response.data?.error ||
        '刷新 token 失败'

      throw new AccountSyncError(message, 502)
    }

    throw new AccountSyncError(error?.message || '刷新 token 网络错误', 503)
  }
}

const persistAccountTokens = async (db, accountId, tokens) => {
  if (!tokens?.accessToken) return null
  const nextRefreshToken = tokens.refreshToken ? String(tokens.refreshToken).trim() : ''

  db.run(
    `UPDATE gpt_accounts SET token = ?, refresh_token = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
    [tokens.accessToken, nextRefreshToken || null, accountId]
  )
  await saveDatabase()
  return { accessToken: tokens.accessToken, refreshToken: nextRefreshToken || null }
}

const loadAccountsForStatusCheck = async (db, { threshold }) => {
  const countResult = db.exec(
    `SELECT COUNT(*) FROM gpt_accounts WHERE created_at >= DATETIME('now', 'localtime', ?) AND COALESCE(is_banned, 0) = 0`,
    [threshold]
  )
  const totalEligible = Number(countResult[0]?.values?.[0]?.[0] || 0)

  const dataResult = db.exec(
    `
      SELECT id,
             email,
             token,
             refresh_token,
             user_count,
             invite_count,
             chatgpt_account_id,
             oai_device_id,
             expire_at,
             is_open,
             COALESCE(is_banned, 0) AS is_banned,
             created_at,
             updated_at,
             COALESCE(account_type, 'unknown') AS account_type,
             plan_type
      FROM gpt_accounts
      WHERE created_at >= DATETIME('now', 'localtime', ?)
        AND COALESCE(is_banned, 0) = 0
      ORDER BY created_at DESC
      LIMIT ?
    `,
    [threshold, MAX_CHECK_ACCOUNTS]
  )

  const rows = dataResult[0]?.values || []
  const accounts = rows.map(row => ({
    id: Number(row[0]),
    email: String(row[1] || ''),
    token: row[2] || '',
    refreshToken: row[3] || null,
    userCount: Number(row[4] || 0),
    inviteCount: Number(row[5] || 0),
    chatgptAccountId: row[6] || '',
    oaiDeviceId: row[7] || '',
    expireAt: row[8] || null,
    isOpen: Boolean(row[9]),
    isDemoted: false,
    isBanned: Boolean(row[10]),
    createdAt: row[11],
    updatedAt: row[12],
    accountType: normalizeStoredAccountType(row[13], row[14]),
    planType: normalizePlanType(row[14])
  }))

  const truncated = totalEligible > accounts.length
  const skipped = truncated ? Math.max(0, totalEligible - accounts.length) : 0

  return {
    totalEligible,
    accounts,
    truncated,
    skipped
  }
}

const checkSingleAccountStatus = async (db, account, nowMs) => {
  const base = {
    id: account.id,
    email: account.email,
    createdAt: account.createdAt,
    expireAt: account.expireAt || null,
    refreshed: false
  }

  if (account.isBanned) {
    return { ...base, status: 'banned', reason: null }
  }

  const checkQuotaStatus = async (targetAccount, options = {}) => {
    const checkedAccounts = await fetchOpenAiAccountInfo(targetAccount.token)
    const quota = selectQuotaSourceFromAccounts(checkedAccounts, nowMs)
    const updatedAccount = await persistAccountProfileFromCheckResult(db, targetAccount, checkedAccounts, quota)
    const normalizedStatus = normalizeQuotaStatus(quota?.status)
    const reason = getQuotaReason(quota)
    const nextExpireAt = updatedAccount?.expireAt || base.expireAt

    if (normalizedStatus === 'normal') {
      return {
        ...base,
        expireAt: nextExpireAt,
        refreshed: Boolean(options.refreshed),
        status: 'normal',
        reason: options.refreshed ? 'Token 已过期，已使用 refresh token 自动刷新' : null
      }
    }

    return {
      ...base,
      expireAt: nextExpireAt,
      refreshed: Boolean(options.refreshed),
      status: 'expired',
      reason: reason || '未检测到有效额度信息'
    }
  }

  try {
    return await checkQuotaStatus(account)
  } catch (error) {
    const message = error?.message ? String(error.message) : String(error || '')
    const status = Number(error?.status || 0)

    if (message.includes('account_deactivated') || message.includes('已自动标记为封号')) {
      return { ...base, status: 'banned', reason: message || null }
    }

    if (status === 401) {
      const storedRefreshToken = String(account.refreshToken || '').trim()
      if (!storedRefreshToken) {
        const reason = message
          ? `${message}`
          : 'Token 已过期或无效（未配置 refresh token）'
        return { ...base, status: 'expired', reason }
      }

      // Best-effort: try to refresh and re-check once.
      try {
        const refreshedTokens = await refreshAccessTokenWithRefreshToken(storedRefreshToken)
        const persisted = await persistAccountTokens(db, account.id, refreshedTokens)

        const nextAccount = {
          ...account,
          token: persisted?.accessToken || account.token,
          refreshToken: persisted?.refreshToken || account.refreshToken
        }

        try {
          return await checkQuotaStatus(nextAccount, { refreshed: true })
        } catch (recheckError) {
          const reMsg = recheckError?.message ? String(recheckError.message) : String(recheckError || '')
          const reStatus = Number(recheckError?.status || 0)

          if (reMsg.includes('account_deactivated') || reMsg.includes('已自动标记为封号')) {
            return { ...base, status: 'banned', refreshed: true, reason: reMsg || null }
          }
          if (reStatus === 401) {
            return {
              ...base,
              status: 'expired',
              refreshed: true,
              reason: reMsg || 'Token 已过期，已尝试刷新但仍无效'
            }
          }
          return { ...base, status: 'failed', refreshed: true, reason: reMsg || 'Token 已过期，已刷新但校验失败' }
        }
      } catch (refreshError) {
        const refreshMsg = refreshError?.message ? String(refreshError.message) : String(refreshError || '')
        const reason = refreshMsg
          ? `Token 已过期，refresh token 刷新失败：${refreshMsg}`
          : 'Token 已过期，refresh token 刷新失败'
        return { ...base, status: 'expired', reason }
      }
    }

    return { ...base, status: 'failed', reason: message || '检查失败' }
  }
}

const lazyDetectAccountType = async (db, account) => {
  if (!account?.token) {
    return account
  }

  const checkedAccounts = await fetchOpenAiAccountInfo(account.token)
  const quota = selectQuotaSourceFromAccounts(checkedAccounts)
  return await persistAccountProfileFromCheckResult(db, account, checkedAccounts, quota)
}

const ensureTeamCapable = async (db, accountId) => {
  const normalizedId = Number(accountId)
  if (!Number.isFinite(normalizedId)) {
    throw new AccountSyncError('Invalid account id', 400)
  }

  let account = await fetchGptAccountById(db, normalizedId)
  if (!account) {
    throw new AccountSyncError('账号不存在', 404)
  }

  const currentType = normalizeStoredAccountType(account.accountType, account.planType)
  if (currentType === 'unknown') {
    account = await lazyDetectAccountType(db, account)
  }

  const finalType = normalizeStoredAccountType(account.accountType, account.planType)
  if (finalType === 'team') return account

  if (finalType === 'personal') {
    throw new AccountSyncError('个人账号不支持 Team 成员操作', 400)
  }

  throw new AccountSyncError('当前账号未识别为 Team 账号，不支持成员操作', 400)
}

// 使用系统设置中的 API 密钥（x-api-key）标记账号为“封号”
router.post('/ban', apiKeyAuth, async (req, res) => {
  try {
    const rawEmails = collectEmails(req.body)
    const emails = [...new Set(rawEmails.map(normalizeEmail).filter(Boolean))]

    if (emails.length === 0) {
      return res.status(400).json({ error: 'emails is required' })
    }
    if (emails.length > 500) {
      return res.status(400).json({ error: 'emails is too large (max 500)' })
    }

    const db = await getDatabase()
    const placeholders = emails.map(() => '?').join(',')

    const existing = db.exec(
      `
        SELECT id, email
        FROM gpt_accounts
        WHERE LOWER(email) IN (${placeholders})
      `,
      emails
    )

    const matched = (existing[0]?.values || [])
      .map(row => ({
        id: Number(row[0]),
        email: String(row[1] || '')
      }))
      .filter(item => Number.isFinite(item.id) && item.email)

    const matchedSet = new Set(matched.map(item => normalizeEmail(item.email)))
    const notFound = emails.filter(email => !matchedSet.has(email))

    if (matched.length > 0) {
      db.run(
        `
          UPDATE gpt_accounts
          SET is_open = 0,
              is_banned = 1,
              updated_at = DATETIME('now', 'localtime')
          WHERE LOWER(email) IN (${placeholders})
        `,
        emails
      )
      await saveDatabase()
    }

    return res.json({
      message: 'ok',
      updated: matched.length,
      matched,
      notFound
    })
  } catch (error) {
    console.error('Ban GPT accounts by email error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.use(authenticateToken, requireMenu('accounts'))

// 校验 access token，并返回可用账号列表（personal + team）
router.post('/check-token', async (req, res) => {
  try {
    const { token, proxy } = req.body || {}
    const normalizedToken = String(token ?? '').trim()
    if (!normalizedToken) {
      return res.status(400).json({ error: 'token is required' })
    }

    const accounts = await fetchOpenAiAccountInfo(normalizedToken, proxy ?? null)
    const quota = selectQuotaSourceFromAccounts(accounts)
    return res.json({ accounts, quota })
  } catch (error) {
    console.error('Check GPT token error:', error)

    if (error instanceof AccountSyncError || error?.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    return res.status(500).json({ error: '内部服务器错误' })
  }
})

// 批量检查指定时间范围内创建的账号状态（封号 / 过期 / 正常 / 失败）
router.post('/check-status', async (req, res) => {
  try {
    const rangeDays = Number.parseInt(String(req.body?.rangeDays ?? ''), 10)
    if (!CHECK_STATUS_ALLOWED_RANGE_DAYS.has(rangeDays)) {
      return res.status(400).json({ error: 'rangeDays must be one of 7, 15, 30' })
    }

    const threshold = `-${rangeDays} days`
    const db = await getDatabase()

    const { totalEligible, accounts, truncated, skipped } = await loadAccountsForStatusCheck(db, { threshold })
    const nowMs = Date.now()
    const items = await mapWithConcurrency(accounts, CHECK_STATUS_CONCURRENCY, async (account) => {
      return await checkSingleAccountStatus(db, account, nowMs)
    })

    const summary = { normal: 0, expired: 0, banned: 0, failed: 0 }
    let refreshedCount = 0
    for (const item of items) {
      if (!item || typeof item.status !== 'string') continue
      if (Object.prototype.hasOwnProperty.call(summary, item.status)) {
        summary[item.status] += 1
      }
      if (item.refreshed) {
        refreshedCount += 1
      }
    }

    return res.json({
      message: 'ok',
      rangeDays,
      checkedTotal: items.length,
      summary,
      refreshedCount,
      items,
      truncated,
      skipped
    })
  } catch (error) {
    console.error('Check GPT account status error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// SSE: 批量检查账号状态，并实时推送进度（text/event-stream）
router.get('/check-status/stream', async (req, res) => {
  try {
    const rangeDays = Number.parseInt(String(req.query?.rangeDays ?? ''), 10)
    if (!CHECK_STATUS_ALLOWED_RANGE_DAYS.has(rangeDays)) {
      return res.status(400).json({ error: 'rangeDays must be one of 7, 15, 30' })
    }

    const threshold = `-${rangeDays} days`
    const db = await getDatabase()
    const { accounts, truncated, skipped } = await loadAccountsForStatusCheck(db, { threshold })

    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private')
    res.setHeader('Connection', 'keep-alive')
    // Hint Nginx not to buffer (best-effort).
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const sendEvent = (event, payload) => {
      if (res.writableEnded) return
      const data = payload == null ? '' : JSON.stringify(payload)
      res.write(`event: ${event}\n`)
      if (data) {
        res.write(`data: ${data}\n`)
      } else {
        res.write('data: {}\n')
      }
      res.write('\n')
    }

    let closed = false
    req.on('close', () => {
      closed = true
    })

    // Keep the connection active behind proxies (default read timeout is often ~60s).
    const keepAliveTimer = setInterval(() => {
      if (closed || res.writableEnded) return
      try {
        res.write(': ping\n\n')
      } catch {
        // ignore
      }
    }, 15000)

    const total = accounts.length
    sendEvent('meta', { rangeDays, total, truncated, skipped })
    sendEvent('progress', { processed: 0, total, percent: total ? 0 : 100 })

    const nowMs = Date.now()
    const summary = { normal: 0, expired: 0, banned: 0, failed: 0 }
    let refreshedCount = 0
    let processed = 0

    try {
      await eachWithConcurrency(accounts, CHECK_STATUS_CONCURRENCY, async (account) => {
        if (closed) return

        const item = await checkSingleAccountStatus(db, account, nowMs)

        processed += 1
        if (Object.prototype.hasOwnProperty.call(summary, item.status)) {
          summary[item.status] += 1
        }
        if (item.refreshed) {
          refreshedCount += 1
        }

        const percent = total ? Math.round((processed / total) * 100) : 100
        sendEvent('item', item)
        sendEvent('progress', { processed, total, percent })
      })

      if (!closed) {
        sendEvent('done', {
          message: 'ok',
          rangeDays,
          checkedTotal: processed,
          summary,
          refreshedCount,
          truncated,
          skipped
        })
      }
    } catch (error) {
      if (!closed) {
        const message = error?.message ? String(error.message) : 'Internal server error'
        sendEvent('error', { error: message })
      }
    } finally {
      clearInterval(keepAliveTimer)
      try {
        res.end()
      } catch {
        // ignore
      }
    }
  } catch (error) {
    console.error('Check GPT account status (SSE) error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// 获取账号列表（支持分页、搜索、筛选）
router.get('/', async (req, res) => {
  try {
    const db = await getDatabase()
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10))
    const search = (req.query.search || '').trim().toLowerCase()
    const openStatus = req.query.openStatus // 'open' | 'closed' | undefined

    // 构建 WHERE 条件
    const conditions = []
    const params = []

    if (search) {
      conditions.push(`(LOWER(email) LIKE ? OR LOWER(token) LIKE ? OR LOWER(refresh_token) LIKE ? OR LOWER(chatgpt_account_id) LIKE ?)`)
      const searchPattern = `%${search}%`
      params.push(searchPattern, searchPattern, searchPattern, searchPattern)
    }

    if (openStatus === 'open') {
      conditions.push('is_open = 1')
    } else if (openStatus === 'closed') {
      conditions.push('(is_open = 0 OR is_open IS NULL)')
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // 查询总数
    const countResult = db.exec(`SELECT COUNT(*) FROM gpt_accounts ${whereClause}`, params)
    const total = countResult[0]?.values?.[0]?.[0] || 0

    // 查询分页数据
    const offset = (page - 1) * pageSize
    const dataResult = db.exec(`
      SELECT ${GPT_ACCOUNT_SELECT_COLUMNS}
      FROM gpt_accounts
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset])

    const accounts = (dataResult[0]?.values || []).map(mapGptAccountRow)

    res.json({
      accounts,
      pagination: { page, pageSize, total }
    })
  } catch (error) {
    console.error('Get GPT accounts error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get a single GPT account
router.get('/:id', async (req, res) => {
  try {
    const db = await getDatabase()
    const account = await fetchGptAccountById(db, req.params.id)
    if (!account) {
      return res.status(404).json({ error: 'Account not found' })
    }

    res.json(account)
  } catch (error) {
    console.error('Get GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Create a new GPT account
router.post('/', async (req, res) => {
  try {
    const body = req.body || {}
    const {
      email,
      token,
      refreshToken,
      userCount,
      chatgptAccountId,
      oaiDeviceId,
      expireAt,
      accountType,
      planType
    } = body

    // isDemoted/is_demoted: deprecated (ignored).

    const hasIsBanned = Object.prototype.hasOwnProperty.call(body, 'isBanned') || Object.prototype.hasOwnProperty.call(body, 'is_banned')
    const isBannedInput = Object.prototype.hasOwnProperty.call(body, 'isBanned') ? body.isBanned : body.is_banned
    const normalizedIsBanned = hasIsBanned ? normalizeBoolean(isBannedInput) : null
    if (hasIsBanned && normalizedIsBanned === null) {
      return res.status(400).json({ error: 'Invalid isBanned format' })
    }
    const isBannedValue = normalizedIsBanned ? 1 : 0

    const normalizedChatgptAccountId = String(chatgptAccountId ?? '').trim()
    const normalizedOaiDeviceId = String(oaiDeviceId ?? '').trim()
    const normalizedExpireAt = normalizeExpireAt(expireAt)
    const normalizedPlanType = normalizePlanType(planType)
    const normalizedAccountType = normalizeStoredAccountType(accountType, normalizedPlanType)

    if (!email || !token || !normalizedChatgptAccountId) {
      return res.status(400).json({ error: 'Email, token and ChatGPT ID are required' })
    }

    if (expireAt != null && String(expireAt).trim() && !normalizedExpireAt) {
      return res.status(400).json({
        error: 'Invalid expireAt format',
        message: 'expireAt 格式错误，请使用 YYYY/MM/DD HH:mm'
      })
    }

    const normalizedEmail = normalizeEmail(email)

    const db = await getDatabase()

    // 设置默认人数为1而不是0
    const finalUserCount = userCount !== undefined ? userCount : 1

    db.run(
      `INSERT INTO gpt_accounts (email, token, refresh_token, user_count, chatgpt_account_id, oai_device_id, expire_at, is_banned, account_type, plan_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
      [
        normalizedEmail,
        token,
        refreshToken || null,
        finalUserCount,
        normalizedChatgptAccountId,
        normalizedOaiDeviceId || null,
        normalizedExpireAt,
        isBannedValue,
        normalizedAccountType,
        normalizedPlanType
      ]
    )

    // 获取新创建账号的ID
    const accountResult = db.exec(`
      SELECT ${GPT_ACCOUNT_SELECT_COLUMNS}
      FROM gpt_accounts
      WHERE id = last_insert_rowid()
    `)
    const account = mapGptAccountRow(accountResult[0].values[0])

    // 生成随机兑换码的辅助函数
    function generateRedemptionCode(length = 12) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 排除容易混淆的字符
      let code = ''
      for (let i = 0; i < length; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length))
        // 每4位添加一个分隔符
        if ((i + 1) % 4 === 0 && i < length - 1) {
          code += '-'
        }
      }
      return code
    }

    // 自动生成兑换码并绑定到该账号
    // Team 账号默认总容量 5，新建账号默认人数按 1 计算，所以默认生成 4 个兑换码
    const totalCapacity = 5
    const currentUserCountForCodes = Math.max(1, Number(finalUserCount) || 1)
    const codesToGenerate = Math.max(0, totalCapacity - currentUserCountForCodes)

    const generatedCodes = []
    for (let i = 0; i < codesToGenerate; i++) {
      let code = generateRedemptionCode()
      let attempts = 0
      let success = false

      // 尝试生成唯一的兑换码（最多重试5次）
      while (attempts < 5 && !success) {
        try {
          db.run(
            `INSERT INTO redemption_codes (code, account_email, created_at, updated_at) VALUES (?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
            [code, normalizedEmail]
          )
          generatedCodes.push(code)
          success = true
        } catch (err) {
          if (err.message.includes('UNIQUE')) {
            // 如果重复，重新生成
            code = generateRedemptionCode()
            attempts++
          } else {
            throw err
          }
        }
      }
    }

    await saveDatabase()

    // 获取生成的兑换码信息
    const codesResult = db.exec(`
      SELECT code FROM redemption_codes
      WHERE account_email = ?
      ORDER BY created_at DESC
    `, [normalizedEmail])

    const codes = codesResult[0]?.values.map(row => row[0]) || []

    res.status(201).json({
      account,
      generatedCodes: codes,
      message: `账号创建成功，已自动生成${codes.length}个兑换码`
    })
  } catch (error) {
    console.error('Create GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Update a GPT account
router.put('/:id', async (req, res) => {
  try {
    const body = req.body || {}
    const {
      email,
      token,
      refreshToken,
      userCount,
      chatgptAccountId,
      oaiDeviceId,
      expireAt,
      accountType,
      planType
    } = body

    const normalizedChatgptAccountId = String(chatgptAccountId ?? '').trim()
    const normalizedOaiDeviceId = String(oaiDeviceId ?? '').trim()
    const hasExpireAt = Object.prototype.hasOwnProperty.call(body, 'expireAt')
    const normalizedExpireAt = hasExpireAt ? normalizeExpireAt(expireAt) : null
    const hasAccountType = Object.prototype.hasOwnProperty.call(body, 'accountType')
    const hasPlanType = Object.prototype.hasOwnProperty.call(body, 'planType')
    const normalizedPlanType = hasPlanType ? normalizePlanType(planType) : null
    const shouldUpdateAccountType = hasAccountType || hasPlanType
    const normalizedAccountType = hasAccountType
      ? normalizeStoredAccountType(accountType, hasPlanType ? normalizedPlanType : null)
      : inferAccountTypeFromPlanType(normalizedPlanType)

    // isDemoted/is_demoted: deprecated (ignored).

    const hasIsBanned = Object.prototype.hasOwnProperty.call(body, 'isBanned') || Object.prototype.hasOwnProperty.call(body, 'is_banned')
    const isBannedInput = Object.prototype.hasOwnProperty.call(body, 'isBanned') ? body.isBanned : body.is_banned
    const normalizedIsBanned = hasIsBanned ? normalizeBoolean(isBannedInput) : null
    if (hasIsBanned && normalizedIsBanned === null) {
      return res.status(400).json({ error: 'Invalid isBanned format' })
    }
    const shouldUpdateIsBanned = hasIsBanned
    const isBannedValue = normalizedIsBanned ? 1 : 0
    const shouldApplyBanSideEffects = shouldUpdateIsBanned && isBannedValue === 1

    if (!email || !token || !normalizedChatgptAccountId) {
      return res.status(400).json({ error: 'Email, token and ChatGPT ID are required' })
    }

    if (hasExpireAt && expireAt != null && String(expireAt).trim() && !normalizedExpireAt) {
      return res.status(400).json({
        error: 'Invalid expireAt format',
        message: 'expireAt 格式错误，请使用 YYYY/MM/DD HH:mm'
      })
    }

    const db = await getDatabase()

    // Check if account exists
    const checkResult = db.exec('SELECT id, email FROM gpt_accounts WHERE id = ?', [req.params.id])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const existingEmail = checkResult[0].values[0][1]

    db.run(
      `UPDATE gpt_accounts
       SET email = ?,
           token = ?,
           refresh_token = ?,
           user_count = ?,
           chatgpt_account_id = ?,
           oai_device_id = ?,
           expire_at = CASE WHEN ? = 1 THEN ? ELSE expire_at END,
           account_type = CASE WHEN ? = 1 THEN ? ELSE account_type END,
           plan_type = CASE WHEN ? = 1 THEN ? ELSE plan_type END,
           is_banned = CASE WHEN ? = 1 THEN ? ELSE is_banned END,
           is_open = CASE WHEN ? = 1 THEN 0 ELSE is_open END,
           ban_processed = CASE WHEN ? = 1 THEN 0 ELSE ban_processed END,
           updated_at = DATETIME('now', 'localtime')
       WHERE id = ?`,
      [
        email,
        token,
        refreshToken || null,
        userCount || 0,
        normalizedChatgptAccountId,
        normalizedOaiDeviceId || null,
        hasExpireAt ? 1 : 0,
        normalizedExpireAt,
        shouldUpdateAccountType ? 1 : 0,
        normalizedAccountType,
        hasPlanType ? 1 : 0,
        normalizedPlanType,
        shouldUpdateIsBanned ? 1 : 0,
        isBannedValue,
        shouldApplyBanSideEffects ? 1 : 0,
        shouldApplyBanSideEffects ? 1 : 0,
        req.params.id
      ]
    )

    if (existingEmail && existingEmail !== email) {
      db.run(
        `UPDATE redemption_codes SET account_email = ?, updated_at = DATETIME('now', 'localtime') WHERE account_email = ?`,
        [email, existingEmail]
      )
    }
    await saveDatabase()
    const account = await fetchGptAccountById(db, req.params.id)

    res.json(account)
  } catch (error) {
    console.error('Update GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 设置账号是否开放展示
router.patch('/:id/open', async (req, res) => {
  try {
    const { isOpen } = req.body || {}
    if (typeof isOpen !== 'boolean') {
      return res.status(400).json({ error: 'isOpen must be a boolean' })
    }

    const db = await getDatabase()

    const checkResult = db.exec('SELECT id, COALESCE(is_banned, 0) AS is_banned FROM gpt_accounts WHERE id = ?', [req.params.id])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const isBanned = Boolean(checkResult[0].values[0][1])
    if (isOpen && isBanned) {
      return res.status(400).json({ error: '账号已封号，不能设置为开放账号' })
    }

    db.run(
      `UPDATE gpt_accounts SET is_open = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
      [isOpen ? 1 : 0, req.params.id]
    )
    await saveDatabase()

    const account = await fetchGptAccountById(db, req.params.id)

    res.json(account)
  } catch (error) {
    console.error('Update GPT account open status error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 标记账号为封号（后台手动操作）
router.patch('/:id/ban', async (req, res) => {
  try {
    const accountId = Number(req.params.id)
    if (!Number.isFinite(accountId)) {
      return res.status(400).json({ error: 'Invalid account id' })
    }

    const db = await getDatabase()
    const checkResult = db.exec('SELECT id FROM gpt_accounts WHERE id = ?', [accountId])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    db.run(
      `
        UPDATE gpt_accounts
        SET is_open = 0,
            is_banned = 1,
            ban_processed = 0,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
      `,
      [accountId]
    )
    await saveDatabase()
    const account = await fetchGptAccountById(db, accountId)

    res.json(account)
  } catch (error) {
    console.error('Ban GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Delete a GPT account
router.delete('/:id', async (req, res) => {
  try {
    const db = await getDatabase()

    // Check if account exists
    const checkResult = db.exec('SELECT id FROM gpt_accounts WHERE id = ?', [req.params.id])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    db.run('DELETE FROM gpt_accounts WHERE id = ?', [req.params.id])
    await saveDatabase()

    res.json({ message: 'Account deleted successfully' })
  } catch (error) {
    console.error('Delete GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 同步账号用户数量
router.post('/:id/sync-user-count', async (req, res) => {
  try {
    const accountId = Number(req.params.id)
    const db = await getDatabase()
    const teamAccount = await ensureTeamCapable(db, accountId)
    const userSync = await syncAccountUserCount(accountId, {
      accountRecord: teamAccount
    })
    const inviteSync = await syncAccountInviteCount(accountId, {
      accountRecord: userSync.account,
      inviteListParams: { offset: 0, limit: 1, query: '' }
    })
    res.json({
      message: '账号同步成功',
      account: inviteSync.account,
      syncedUserCount: userSync.syncedUserCount,
      inviteCount: inviteSync.inviteCount,
      users: userSync.users
    })
  } catch (error) {
    console.error('同步账号人数错误:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

router.delete('/:id/users/:userId', async (req, res) => {
  try {
    const db = await getDatabase()
    const teamAccount = await ensureTeamCapable(db, Number(req.params.id))
    const { account, syncedUserCount, users } = await deleteAccountUser(Number(req.params.id), req.params.userId, {
      accountRecord: teamAccount
    })
    res.json({
      message: '成员删除成功',
      account,
      syncedUserCount,
      users
    })
  } catch (error) {
    console.error('删除成员失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

router.post('/:id/invite-user', async (req, res) => {
  try {
    const { email } = req.body || {}
    if (!email) {
      return res.status(400).json({ error: '请提供邀请邮箱地址' })
    }
    const db = await getDatabase()
    const teamAccount = await ensureTeamCapable(db, Number(req.params.id))
    const result = await inviteAccountUser(Number(req.params.id), email, {
      accountRecord: teamAccount
    })
    let inviteCount = null
    try {
      const synced = await syncAccountInviteCount(Number(req.params.id), {
        accountRecord: teamAccount,
        inviteListParams: { offset: 0, limit: 1, query: '' }
      })
      inviteCount = synced.inviteCount
    } catch (syncError) {
      console.warn('邀请发送成功，但同步邀请数失败:', syncError?.message || syncError)
    }

    res.json({
      ...result,
      inviteCount
    })
  } catch (error) {
    console.error('邀请成员失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 查询已邀请列表（用于统计待加入人数）
router.get('/:id/invites', async (req, res) => {
  try {
    const db = await getDatabase()
    const teamAccount = await ensureTeamCapable(db, Number(req.params.id))
    const { invites } = await syncAccountInviteCount(Number(req.params.id), {
      accountRecord: teamAccount,
      inviteListParams: req.query || {}
    })
    res.json(invites)
  } catch (error) {
    console.error('获取邀请列表失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 撤回邀请
router.delete('/:id/invites', async (req, res) => {
  try {
    const emailAddress = req.body?.email_address || req.body?.emailAddress || req.body?.email
    if (!emailAddress) {
      return res.status(400).json({ error: '请提供邀请邮箱地址' })
    }

    const db = await getDatabase()
    const teamAccount = await ensureTeamCapable(db, Number(req.params.id))
    const result = await deleteAccountInvite(Number(req.params.id), emailAddress, {
      accountRecord: teamAccount
    })
    res.json(result)
  } catch (error) {
    console.error('撤回邀请失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 刷新账号的 access token
router.post('/:id/refresh-token', async (req, res) => {
  try {
    const db = await getDatabase()

    const account = await fetchGptAccountById(db, req.params.id)
    if (!account) {
      return res.status(404).json({ error: '账号不存在' })
    }

    const refreshToken = account.refreshToken

    if (!refreshToken) {
      return res.status(400).json({ error: '该账号未配置 refresh token' })
    }

    const requestData = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OPENAI_CLIENT_ID,
      refresh_token: refreshToken,
      scope: 'openid profile email'
    }).toString()

    const requestOptions = {
      method: 'POST',
      url: 'https://auth.openai.com/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': requestData.length
      },
      data: requestData,
      timeout: 60000
    }

    const response = await axios(requestOptions)

    if (response.status !== 200 || !response.data?.access_token) {
      return res.status(500).json({ error: '刷新 token 失败，未返回有效凭证' })
    }

    const resultData = response.data

    db.run(
      `UPDATE gpt_accounts SET token = ?, refresh_token = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
      [resultData.access_token, resultData.refresh_token || refreshToken, req.params.id]
    )
    await saveDatabase()

    const updatedAccount = await fetchGptAccountById(db, req.params.id)

    res.json({
      message: 'Token 刷新成功',
      account: updatedAccount,
      accessToken: resultData.access_token,
      idToken: resultData.id_token,
      refreshToken: resultData.refresh_token || refreshToken,
      expiresIn: resultData.expires_in || 3600
    })
  } catch (error) {
    console.error('刷新 token 错误:', error?.response?.data || error.message || error)

    if (error.response) {
      const message =
        error.response.data?.error?.message ||
        error.response.data?.error_description ||
        error.response.data?.error ||
        '刷新 token 失败'

      // 不直接透传 OpenAI 的状态码，统一返回 502 表示上游服务错误
      return res.status(502).json({
        error: message,
        upstream_status: error.response.status
      })
    }

    res.status(500).json({ error: '刷新 token 时发生内部错误' })
  }
})

export default router
