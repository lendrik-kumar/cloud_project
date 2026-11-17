import { useState, type FormEvent } from 'react';
import { confirmSignIn, signIn, type SignInOutput } from 'aws-amplify/auth';
import { errorMessage } from '../api';
import { useAuth } from '../auth-context';
import { Alert, Spinner } from '../components/ui';

type Stage = 'credentials' | 'newPassword';

function friendlyError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  switch (name) {
    case 'NotAuthorizedException':
      return errorMessage(err).includes('expired')
        ? 'Your temporary password has expired. Ask your teacher or administrator to resend it.'
        : 'Incorrect email or password.';
    case 'UserNotFoundException':
      return 'Incorrect email or password.';
    case 'PasswordResetRequiredException':
      return 'A password reset is required for this account. Ask your administrator to reset it.';
    case 'InvalidPasswordException':
      return errorMessage(err);
    case 'EmptySignInUsername':
      return 'Enter your email.';
    case 'EmptySignInPassword':
      return 'Enter your password.';
    default:
      return errorMessage(err);
  }
}

export function SignInPage() {
  const { refresh } = useAuth();
  const [stage, setStage] = useState<Stage>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const handleStep = async (out: SignInOutput) => {
    const step = out.nextStep.signInStep;
    if (out.isSignedIn || step === 'DONE') {
      await refresh();
      return;
    }
    if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
      setStage('newPassword');
      return;
    }
    if (step === 'RESET_PASSWORD') {
      setError('A password reset is required for this account. Ask your administrator to reset it.');
      return;
    }
    if (step === 'CONFIRM_SIGN_UP') {
      setError('This account has not been confirmed yet.');
      return;
    }
    setError(`This sign-in step is not supported by CloudAttend (${step}).`);
  };

  const onSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await handleStep(await signIn({ username: email.trim(), password }));
    } catch (err) {
      if ((err as { name?: string })?.name === 'UserAlreadyAuthenticatedException') {
        await refresh();
      } else {
        setError(friendlyError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const onNewPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    if (newPassword !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await handleStep(await confirmSignIn({ challengeResponse: newPassword }));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card card">
        <div className="brand brand-lg">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>CloudAttend</span>
        </div>

        {stage === 'credentials' ? (
          <form onSubmit={onSignIn} className="form">
            <p className="muted">Sign in with the email your account was created with.</p>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && <Alert>{error}</Alert>}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy && <Spinner small />} Sign in
            </button>
            <p className="muted small">
              First time? Use the temporary password from your invitation email; you will then
              choose your own.
            </p>
          </form>
        ) : (
          <form onSubmit={onNewPassword} className="form">
            <h2>Choose a new password</h2>
            <p className="muted">
              You signed in with a temporary password. Set a new one to continue
              {email ? ` as ${email.trim()}` : ''}.
            </p>
            <label className="field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoFocus
              />
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
            <p className="muted small">
              At least 8 characters; your pool may also require upper and lower case letters, a
              number and a symbol.
            </p>
            {error && <Alert>{error}</Alert>}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy && <Spinner small />} Set password and sign in
            </button>
            <button
              type="button"
              className="btn btn-link"
              onClick={() => {
                setStage('credentials');
                setPassword('');
                setNewPassword('');
                setConfirmPassword('');
                setError(undefined);
              }}
            >
              Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
