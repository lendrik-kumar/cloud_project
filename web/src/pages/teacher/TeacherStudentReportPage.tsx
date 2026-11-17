import { Link, useParams } from 'react-router-dom';
import { StudentReportView } from '../student/StudentReportView';

export function TeacherStudentReportPage() {
  const { studentId = '' } = useParams();
  return (
    <>
      <p className="crumbs page-crumbs">
        <Link to="/students">Students</Link> /
      </p>
      <StudentReportView studentId={studentId} />
    </>
  );
}
