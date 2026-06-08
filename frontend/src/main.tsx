import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from 'react-oidc-context'
import { ENV } from './env'
import App from './App'

// Derive region from pool ID (format: <region>_<id>)
const cognitoRegion = ENV.cognitoUserPoolId.split('_')[0]
const cognitoIdpBase = `https://cognito-idp.${cognitoRegion}.amazonaws.com`

const oidcConfig = {
  authority: `${ENV.cognitoDomain.replace(/\/$/, '')}`,
  client_id: ENV.cognitoClientId,
  redirect_uri: `${ENV.appUrl}/callback`,
  post_logout_redirect_uri: `${ENV.appUrl}/`,
  scope: 'openid email profile',
  metadata: {
    issuer: `${cognitoIdpBase}/${ENV.cognitoUserPoolId}`,
    authorization_endpoint: `${ENV.cognitoDomain}/oauth2/authorize`,
    token_endpoint: `${ENV.cognitoDomain}/oauth2/token`,
    end_session_endpoint: `${ENV.cognitoDomain}/logout`,
    jwks_uri: `${cognitoIdpBase}/${ENV.cognitoUserPoolId}/.well-known/jwks.json`,
  },
  onSigninCallback: () => {
    // Clean up the PKCE callback params and redirect to /c/new
    window.history.replaceState({}, document.title, '/c/new')
  },
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider {...oidcConfig}>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
)
