export function ConfigErrorPage({ message }: { message: string }) {
  return (
    <div className="auth-screen">
      <div className="auth-card card">
        <div className="brand brand-lg">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>CloudAttend</span>
        </div>
        <h2>Configuration missing</h2>
        <div className="alert alert-error" role="alert">
          <div className="alert-body">{message}</div>
        </div>
        <p>
          The dashboard reads <code>config.json</code> (API URL and Cognito IDs) from the same
          folder as <code>index.html</code>.
        </p>
        <ul className="small">
          <li>
            <strong>Deployed site:</strong> the CDK stack writes it on deploy. Redeploy{' '}
            <code>CloudAttendStack</code>.
          </li>
          <li>
            <strong>Local dev:</strong> after deploying the stack, run{' '}
            <code>scripts/write-local-config.sh</code> to create <code>web/public/config.json</code>,
            then restart <code>npm run dev</code>.
          </li>
        </ul>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    </div>
  );
}
