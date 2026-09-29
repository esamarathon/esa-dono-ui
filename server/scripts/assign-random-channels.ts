import prisma from '../lib/prisma.js';

async function main() {
  const channels = await prisma.channel.findMany({ where: { is_active: true } });
  if (channels.length === 0) {
    console.error('No active channels found. Create some channels first.');
    process.exit(1);
  }

  const donations = await prisma.donation.findMany({
    where: { channel_id: null },
    select: { id: true, external_id: true },
  });

  if (donations.length === 0) {
    console.log('No unassigned donations found.');
    return;
  }

  console.log(`Found ${donations.length} donations without a channel.`);
  console.log(`Assigning to one of ${channels.length} active channels...`);

  let updated = 0;
  for (const donation of donations) {
    const channel = channels[Math.floor(Math.random() * channels.length)]!;
    await prisma.donation.update({
      where: { id: donation.id },
      data: { channel_id: channel.id },
    });
    console.log(`  ${donation.external_id} → ${channel.name}`);
    updated++;
  }

  console.log(`Done. Assigned ${updated} donations to random channels.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
