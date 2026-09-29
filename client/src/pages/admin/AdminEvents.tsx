import adminClient from '../../api/admin';
import EventsManager from '../../components/EventsManager';

export default function AdminEvents() {
  return <EventsManager client={adminClient} />;
}
