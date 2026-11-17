import { useMe } from '../../auth-context';
import { Alert } from '../../components/ui';
import { StudentReportView } from './StudentReportView';

export function MyAttendancePage() {
  const me = useMe();
  if (!me.studentId) {
    return (
      <div className="page">
        <Alert>
          Your login is not linked to a student record (no <code>custom:studentId</code>). Ask your teacher to
          check your enrollment.
        </Alert>
      </div>
    );
  }
  return <StudentReportView studentId={me.studentId} heading="My attendance" />;
}
