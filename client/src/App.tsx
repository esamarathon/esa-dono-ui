import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import DonateFlow from './pages/DonateFlow';
import PledgeReturn from './pages/PledgeReturn';
import MyWallet from './pages/MyWallet';
import Rewards from './pages/Rewards';
import Polls from './pages/Polls';
import Goals from './pages/Goals';
import AdminLayout from './pages/admin/AdminLayout';
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminRewards from './pages/admin/AdminRewards';
import AdminPolls from './pages/admin/AdminPolls';
import AdminGoals from './pages/admin/AdminGoals';
import AdminDonations from './pages/admin/AdminDonations';
import AdminSimulate from './pages/admin/AdminSimulate';
import AdminDonors from './pages/admin/AdminDonors';
import AdminBlockedWords from './pages/admin/AdminBlockedWords';
import AdminPledges from './pages/admin/AdminPledges';
import ModeratorLayout from './pages/moderator/ModeratorLayout';
import ModeratorDashboard from './pages/moderator/ModeratorDashboard';
import ModeratorPolls from './pages/moderator/ModeratorPolls';
import ModeratorRewards from './pages/moderator/ModeratorRewards';
import ModeratorGoals from './pages/moderator/ModeratorGoals';
import ModeratorClaims from './pages/moderator/ModeratorClaims';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminDashboard />} />
          <Route path="donors" element={<AdminDonors />} />
          <Route path="rewards" element={<AdminRewards />} />
          <Route path="polls" element={<AdminPolls />} />
          <Route path="goals" element={<AdminGoals />} />
          <Route path="donations" element={<AdminDonations />} />
          <Route path="simulate" element={<AdminSimulate />} />
          <Route path="pledges" element={<AdminPledges />} />
          <Route path="blocked-words" element={<AdminBlockedWords />} />
        </Route>
        <Route path="/moderate" element={<ModeratorLayout />}>
          <Route index element={<ModeratorDashboard />} />
          <Route path="polls" element={<ModeratorPolls />} />
          <Route path="rewards" element={<ModeratorRewards />} />
          <Route path="goals" element={<ModeratorGoals />} />
          <Route path="claims" element={<ModeratorClaims />} />
        </Route>
        <Route
          path="*"
          element={
            <div className="min-h-screen">
              <Navbar />
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/donate" element={<DonateFlow />} />
                <Route path="/pledge/:token" element={<PledgeReturn />} />
                <Route path="/wallet" element={<MyWallet />} />
                <Route path="/rewards" element={<Rewards />} />
                <Route path="/polls" element={<Polls />} />
                <Route path="/goals" element={<Goals />} />
              </Routes>
            </div>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
