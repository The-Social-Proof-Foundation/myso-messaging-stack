import { Navigate, Route, Routes } from 'react-router-dom';
import { AppHeader } from './components/AppHeader';
import { useMobileChatNav } from './contexts/MobileChatNavContext';
import { HomePage } from './pages/HomePage';
import { SettingsPage } from './pages/SettingsPage';

function App() {
  const { hideAppHeader } = useMobileChatNav();

  return (
    <div className="flex h-screen flex-col bg-secondary-50 dark:bg-secondary-950">
      {!hideAppHeader ? <AppHeader /> : null}
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

export default App;
