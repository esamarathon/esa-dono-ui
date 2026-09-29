import moderatorClient from '../../api/moderator';
import ChannelsManager from '../../components/ChannelsManager';

export default function ModeratorChannels() {
  return <ChannelsManager client={moderatorClient} />;
}
