// Temporary DB inspection helper (delete after Phase 1 verification).
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  const shops = await p.shops.findMany({
    select: { shop_domain: true, installed_at: true, uninstalled_at: true },
  });
  console.log("shops:", JSON.stringify(shops, null, 1));

  const visitors = await p.visitors.findMany({ take: 5 });
  console.log("visitors (5):", JSON.stringify(visitors, null, 1));

  const events = await p.events.findMany({ take: 5, orderBy: { occurred_at: "desc" } });
  console.log("events (5 latest):", JSON.stringify(events, null, 1));

  const [{ count: eventCount }] = await p.$queryRawUnsafe(
    "SELECT count(*)::int AS count FROM events",
  );
  console.log("events count:", eventCount);
  await p.$disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
