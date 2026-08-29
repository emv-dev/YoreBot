import { invoke } from '@tauri-apps/api/core'

export type YoreBotAccessStatus = {
  fullAccess: boolean
  hasSavedKey: boolean
  paidControlsAvailable: boolean
  monthlyCheckoutUrl: string | null
  yearlyCheckoutUrl: string | null
  manageUrl: string | null
}

export const EMPTY_YOREBOT_ACCESS_STATUS: YoreBotAccessStatus = {
  fullAccess: false,
  hasSavedKey: false,
  paidControlsAvailable: false,
  monthlyCheckoutUrl: null,
  yearlyCheckoutUrl: null,
  manageUrl: null,
}

export const getYoreBotAccessStatus = () =>
  invoke<YoreBotAccessStatus>('yorebot_access_status')

export const refreshSavedYoreBotAccess = () =>
  invoke<YoreBotAccessStatus>('yorebot_access_refresh_saved')

export const restoreYoreBotAccess = (licenseKey: string) =>
  invoke<YoreBotAccessStatus>('yorebot_access_restore', { licenseKey })

export const forgetYoreBotAccess = () =>
  invoke<YoreBotAccessStatus>('yorebot_access_forget')
