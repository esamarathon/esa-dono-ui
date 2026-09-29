import adminClient from '../../api/admin';
import ChannelsManager from '../../components/ChannelsManager';

export default function AdminChannels() {
  return <ChannelsManager client={adminClient} />;
}
