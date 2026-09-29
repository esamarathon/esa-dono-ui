import moderatorClient from '../../api/moderator';
import EventsManager from '../../components/EventsManager';

export default function ModeratorEvents() {
  return <EventsManager client={moderatorClient} />;
}
