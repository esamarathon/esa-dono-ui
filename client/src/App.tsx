import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import Navbar from './components/Navbar';
import CartDrawer from './components/CartDrawer';
import { CartProvider } from './context/CartContext';
import { track } from './lib/tracing';
import Home from './pages/Home';
import DonateFlow from './pages/DonateFlow';
import PledgeReturn from './pages/PledgeReturn';
import MyWallet from './pages/MyWallet';
import Help from './pages/Help';
import Auctions from './pages/Auctions';
import AdminLayout from './pages/admin/AdminLayout';
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminChannels from './pages/admin/AdminChannels';
import AdminRewards from './pages/admin/AdminRewards';
import AdminPolls from './pages/admin/AdminPolls';
import AdminGoals from './pages/admin/AdminGoals';
import AdminDonations from './pages/admin/AdminDonations';
import AdminSimulate from './pages/admin/AdminSimulate';
import AdminDonors from './pages/admin/AdminDonors';
import AdminBlockedWords from './pages/admin/AdminBlockedWords';
import AdminPledges from './pages/admin/AdminPledges';
import AdminAuctions from './pages/admin/AdminAuctions';
import AdminDestinations from './pages/admin/AdminDestinations';
import ModeratorLayout from './pages/moderator/ModeratorLayout';
import ModeratorDashboard from './pages/moderator/ModeratorDashboard';
import ModeratorChannels from './pages/moderator/ModeratorChannels';
import ModeratorPolls from './pages/moderator/ModeratorPolls';
import ModeratorRewards from './pages/moderator/ModeratorRewards';
import ModeratorGoals from './pages/moderator/ModeratorGoals';
import ModeratorClaims from './pages/moderator/ModeratorClaims';
import ModeratorDonations from './pages/moderator/ModeratorDonations';
import ModeratorAuctions from './pages/moderator/ModeratorAuctions';

/** Fires a `page_view` span on every client-side route change. */
function PageViewTracker() {
  const location = useLocation();
  useEffect(() => {
    track('page_view', { 'page.path': location.pathname, 'page.title': document.title });
  }, [location.pathname]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminDashboard />} />
          <Route path="donors" element={<AdminDonors />} />
          <Route path="channels" element={<AdminChannels />} />
          <Route path="rewards" element={<AdminRewards />} />
          <Route path="polls" element={<AdminPolls />} />
          <Route path="goals" element={<AdminGoals />} />
          <Route path="donations" element={<AdminDonations />} />
          <Route path="simulate" element={<AdminSimulate />} />
          <Route path="pledges" element={<AdminPledges />} />
          <Route path="blocked-words" element={<AdminBlockedWords />} />
          <Route path="auctions" element={<AdminAuctions />} />
          <Route path="destinations" element={<AdminDestinations />} />
        </Route>
        <Route path="/moderate" element={<ModeratorLayout />}>
          <Route index element={<ModeratorDashboard />} />
          <Route path="channels" element={<ModeratorChannels />} />
          <Route path="polls" element={<ModeratorPolls />} />
          <Route path="rewards" element={<ModeratorRewards />} />
          <Route path="goals" element={<ModeratorGoals />} />
          <Route path="claims" element={<ModeratorClaims />} />
          <Route path="donations" element={<ModeratorDonations />} />
          <Route path="auctions" element={<ModeratorAuctions />} />
        </Route>
        <Route
          path="*"
          element={
            <div className="min-h-screen">
              <CartProvider>
                <PageViewTracker />
                <Navbar />
                <CartDrawer />
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/donate" element={<DonateFlow />} />
                  <Route path="/pledge/:token" element={<PledgeReturn />} />
                  <Route path="/wallet" element={<MyWallet />} />
                  <Route path="/help" element={<Help />} />
                  <Route path="/rewards" element={<DonateFlow />} />
                  <Route path="/polls" element={<DonateFlow />} />
                  <Route path="/goals" element={<DonateFlow />} />
                  <Route path="/auctions" element={<Auctions />} />
                </Routes>
              </CartProvider>
            </div>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
