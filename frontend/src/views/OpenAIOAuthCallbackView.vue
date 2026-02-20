<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { openaiOAuthService, type OpenAIOAuthExchangeResult } from '@/services/api'

const OPENAI_OAUTH_MESSAGE_TYPE = 'openai-oauth-result'
const OPENAI_OAUTH_RESULT_STORAGE_KEY = 'openai_oauth_result'

const route = useRoute()
const router = useRouter()

const status = ref<'pending' | 'success' | 'error'>('pending')
const message = ref('正在处理 OpenAI 授权回调...')
const detail = ref('')

const normalizeQueryValue = (value: unknown) => {
  if (Array.isArray(value)) return String(value[0] || '').trim()
  return String(value || '').trim()
}

const publishOAuthResult = (result: OpenAIOAuthExchangeResult) => {
  const payload = {
    type: OPENAI_OAUTH_MESSAGE_TYPE,
    result,
    createdAt: Date.now()
  }

  try {
    sessionStorage.setItem(OPENAI_OAUTH_RESULT_STORAGE_KEY, JSON.stringify(payload))
  } catch (error) {
    console.warn('[OpenAI OAuth Callback] failed to persist callback result', error)
  }

  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin)
    }
  } catch (error) {
    console.warn('[OpenAI OAuth Callback] postMessage failed', error)
  }
}

const navigateBack = () => {
  router.replace('/admin/accounts')
}

onMounted(async () => {
  const code = normalizeQueryValue(route.query.code)
  const state = normalizeQueryValue(route.query.state)
  const sessionId = normalizeQueryValue(route.query.sessionId)
  const oauthError = normalizeQueryValue(route.query.error)
  const oauthErrorDescription = normalizeQueryValue(route.query.error_description)

  if (oauthError) {
    status.value = 'error'
    message.value = '授权被拒绝或失败'
    detail.value = oauthErrorDescription || oauthError
    return
  }

  if (!code || !state) {
    status.value = 'error'
    message.value = '回调参数不完整'
    detail.value = '缺少 code 或 state，请返回账号页重新发起授权。'
    return
  }

  try {
    const result = await openaiOAuthService.exchangeCode({
      code,
      state,
      ...(sessionId ? { sessionId } : {})
    })

    publishOAuthResult(result)

    status.value = 'success'
    message.value = '授权成功，正在返回账号页...'
    detail.value = ''

    setTimeout(() => {
      if (window.opener && !window.opener.closed) {
        try {
          window.close()
          return
        } catch {
          // ignore and fallback
        }
      }
      navigateBack()
    }, 800)
  } catch (error: any) {
    status.value = 'error'
    message.value = '授权码兑换失败'
    detail.value =
      error?.response?.data?.error ||
      error?.response?.data?.message ||
      error?.message ||
      '请返回账号页重试'
  }
})
</script>

<template>
  <div class="min-h-screen bg-gray-50 flex items-center justify-center px-4">
    <div class="w-full max-w-lg bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
      <h1 class="text-lg font-semibold text-gray-900">OpenAI 授权回调</h1>
      <p class="mt-3 text-sm text-gray-700">{{ message }}</p>
      <p v-if="detail" class="mt-2 text-sm text-red-600 break-all">{{ detail }}</p>

      <div class="mt-6 flex items-center gap-3">
        <button
          type="button"
          class="h-10 px-4 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
          @click="navigateBack"
        >
          返回账号页
        </button>
        <span v-if="status === 'pending'" class="text-sm text-gray-500">处理中...</span>
      </div>
    </div>
  </div>
</template>
