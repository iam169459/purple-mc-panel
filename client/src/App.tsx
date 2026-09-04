import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout';
import { Dashboard } from './pages/Dashboard';
import { ConsolePage } from './pages/Console';
import { FilesPage } from './pages/Files';
import { PlayersPage } from './pages/Players';
import { PluginsPage } from './pages/Plugins';
import { TasksPage } from './pages/Tasks';
import { BackupsPage } from './pages/Backups';
import { NetworkPage } from './pages/Network';
import { ServerPage } from './pages/ServerProps';
import { SettingsPage } from './pages/Settings';
import { UpdatesPage } from './pages/Updates';

export function App(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/console" element={<ConsolePage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/players" element={<PlayersPage />} />
        <Route path="/plugins" element={<PluginsPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/backups" element={<BackupsPage />} />
        <Route path="/network" element={<NetworkPage />} />
        <Route path="/server" element={<ServerPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/updates" element={<UpdatesPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
