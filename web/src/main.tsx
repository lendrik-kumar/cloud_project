import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import './index.css';
import App from './App';
import { AuthProvider } from './AuthProvider';
import { ConfigError, loadConfig } from './config';
import { ConfigErrorPage } from './pages/ConfigErrorPage';

const root = createRoot(document.getElementById('root')!);

loadConfig()
  .then((cfg) => {
    Amplify.configure({
      Auth: { Cognito: { userPoolId: cfg.userPoolId, userPoolClientId: cfg.userPoolClientId } },
    });
    root.render(
      <StrictMode>
        <AuthProvider>
          <App />
        </AuthProvider>
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    const message = err instanceof ConfigError ? err.message : `Startup failed: ${String(err)}`;
    root.render(<ConfigErrorPage message={message} />);
  });
