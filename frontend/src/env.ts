/// <reference types="vite/client" />

export const ENV = {
  apiBaseUrl:        (import.meta.env.VITE_API_BASE_URL as string) ?? '',
  wsUrl:             (import.meta.env.VITE_WS_URL as string) ?? '',
  cognitoUserPoolId: (import.meta.env.VITE_COGNITO_USER_POOL_ID as string) ?? '',
  cognitoClientId:   (import.meta.env.VITE_COGNITO_CLIENT_ID as string) ?? '',
  cognitoDomain:     (import.meta.env.VITE_COGNITO_DOMAIN as string) ?? '',
  appUrl:            (import.meta.env.VITE_APP_URL as string) ?? '',
}
