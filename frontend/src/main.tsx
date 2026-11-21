import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from 'react-oidc-context'
import { WebStorageStateStore, type User } from 'oidc-client-ts'
import { ENV } from './env'
import { installViewportHeightTracking } from './lib/viewportHeight'
import App from './App'
import { returnPathFromState } from './lib/authRedirect'

installViewportHeightTracking()

// Derive region from pool ID (format: <region>_<id>)
const cognitoRegion = ENV.cognitoUserPoolId.split('_')[0]
const cognitoIdpBase = `https://cognito-idp.${cognitoRegion}.amazonaws.com`

const oidcConfig = {
  authority: `${ENV.cognitoDomain.replace(/\/$/, '')}`,
  client_id: ENV.cognitoClientId,
  redirect_uri: `${ENV.appUrl}/callback`,
  post_logout_redirect_uri: `${ENV.appUrl}/`,
  scope: 'openid email profile',
  // Store tokens in localStorage so Playwright storageState can capture them
  userStore: new WebStorageStateStore({ store: window.localStorage }),
  metadata: {
    issuer: `${cognitoIdpBase}/${ENV.cognitoUserPoolId}`,
    authorization_endpoint: `${ENV.cognitoDomain}/oauth2/authorize`,
    token_endpoint: `${ENV.cognitoDomain}/oauth2/token`,
    end_session_endpoint: `${ENV.cognitoDomain}/logout`,
    jwks_uri: `${cognitoIdpBase}/${ENV.cognitoUserPoolId}/.well-known/jwks.json`,
  },
  onSigninCallback: (user: User | undefined) => {
    // Clean up the PKCE callback params and return to the page that started the sign-in
    window.history.replaceState({}, document.title, returnPathFromState(user?.state))
    // replaceState is invisible to React Router, which would otherwise keep routing /callback
    window.dispatchEvent(new PopStateEvent('popstate'))
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
