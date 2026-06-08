import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import IndexPage from './pages/IndexPage';
import RecordsPage from './pages/RecordsPage';
import RealtimePage from './pages/RealtimePage';
import PlanStatsPage from './pages/PlanStatsPage';
import GoalStatsPage from './pages/GoalStatsPage';
import UploadPage from './pages/UploadPage';
import AdminPage from './pages/AdminPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* 需登入的頁面共用 Layout */}
      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route path="/" element={<IndexPage />} />
        <Route path="/records" element={<ProtectedRoute permission="view_records"><RecordsPage /></ProtectedRoute>} />
        <Route path="/realtime" element={<RealtimePage />} />
        <Route path="/plan-stats" element={<ProtectedRoute permission="view_plan_stats"><PlanStatsPage /></ProtectedRoute>} />
        <Route path="/goal-stats" element={<ProtectedRoute permission="view_goal_stats"><GoalStatsPage /></ProtectedRoute>} />
        <Route path="/upload" element={<ProtectedRoute permission="upload"><UploadPage /></ProtectedRoute>} />
        <Route path="/admin" element={<ProtectedRoute permission="manage_accounts"><AdminPage /></ProtectedRoute>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
