import bcrypt from 'bcryptjs';
import pg from 'pg';
import { pool, logger } from './db.js';
import { runMigrations } from './migrate.js';

interface SeedOptions {
  itemCount: number;
  activityCount: number;
  force: boolean;
  pool?: pg.Pool;
}

export const DEMO_PASSWORD = 'Password123!';

export async function runSeed(options: SeedOptions): Promise<void> {
  const activePool = options.pool || pool;
  const client = await activePool.connect();

  try {
    // 1. Check if DB has items already
    try {
      const checkRes = await client.query('SELECT COUNT(*)::int as count FROM items');
      const count = checkRes.rows[0]?.count || 0;
      if (count > 0 && !options.force) {
        throw new Error(`Database already contains ${count} items. Pass --force to reset and re-seed.`);
      }
    } catch (checkErr: any) {
      if (checkErr.code !== '42P01') { // 42P01 = undefined_table (safe if unmigrated)
        if (!options.force && checkErr.message.includes('already contains')) {
          throw checkErr;
        }
      }
    }

    if (options.force) {
      logger.info('Resetting schema for clean seed (--force provided)...');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await runMigrations(activePool);
    }

    logger.info('Starting seed insertion...');

    // 2. Hash demo password once
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

    // 3. Insert Teams
    const teams = [
      { name: 'Operations & Support', slug: 'operations', prefix: 'OPS' },
      { name: 'Platform Engineering', slug: 'engineering', prefix: 'ENG' },
      { name: 'Payments & Compliance', slug: 'payments', prefix: 'PAY' },
    ];

    const teamMap = new Map<string, { id: string; prefix: string }>();

    for (const t of teams) {
      const res = await client.query(
        `INSERT INTO teams (name, slug, prefix, item_counter)
         VALUES ($1, $2, $3, 1000)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, slug, prefix`,
        [t.name, t.slug, t.prefix]
      );
      teamMap.set(t.slug, { id: res.rows[0].id, prefix: res.rows[0].prefix });
    }

    // 4. Insert 25 Users with defined roles
    // Notice: priya.lead is lead in operations, viewer in engineering
    // Each team has at least 2 leads for separation of duties demonstration
    const usersData = [
      { email: 'admin@newtonite.local', name: 'Alice Admin', is_org_admin: true },
      // Operations Team
      { email: 'priya.lead@newtonite.local', name: 'Priya Sharma', is_org_admin: false },
      { email: 'marcus.lead@newtonite.local', name: 'Marcus Vance', is_org_admin: false },
      { email: 'elena.member@newtonite.local', name: 'Elena Rostova', is_org_admin: false },
      { email: 'david.member@newtonite.local', name: 'David Chen', is_org_admin: false },
      { email: 'sarah.viewer@newtonite.local', name: 'Sarah Jenkins', is_org_admin: false },
      // Engineering Team
      { email: 'arjun.lead@newtonite.local', name: 'Arjun Patel', is_org_admin: false },
      { email: 'clara.lead@newtonite.local', name: 'Clara Oswald', is_org_admin: false },
      { email: 'kevin.member@newtonite.local', name: 'Kevin Miller', is_org_admin: false },
      { email: 'aisha.member@newtonite.local', name: 'Aisha Khan', is_org_admin: false },
      { email: 'todd.member@newtonite.local', name: 'Todd Howard', is_org_admin: false },
      { email: 'simon.viewer@newtonite.local', name: 'Simon Riley', is_org_admin: false },
      // Payments Team
      { email: 'sofia.lead@newtonite.local', name: 'Sofia Rossi', is_org_admin: false },
      { email: 'liam.lead@newtonite.local', name: 'Liam O\'Connor', is_org_admin: false },
      { email: 'zoya.member@newtonite.local', name: 'Zoya Akhtar', is_org_admin: false },
      { email: 'hassan.member@newtonite.local', name: 'Hassan Ali', is_org_admin: false },
      { email: 'chloe.member@newtonite.local', name: 'Chloe Decker', is_org_admin: false },
      { email: 'rachel.viewer@newtonite.local', name: 'Rachel Green', is_org_admin: false },
      // Additional specialists & cross-team staff (up to 25)
      { email: 'maya.auditor@newtonite.local', name: 'Maya Lin', is_org_admin: false },
      { email: 'victor.ops@newtonite.local', name: 'Victor Stone', is_org_admin: false },
      { email: 'sam.security@newtonite.local', name: 'Sam Fisher', is_org_admin: false },
      { email: 'leila.support@newtonite.local', name: 'Leila Vance', is_org_admin: false },
      { email: 'oscar.devops@newtonite.local', name: 'Oscar Isaac', is_org_admin: false },
      { email: 'tariq.finance@newtonite.local', name: 'Tariq Nasheed', is_org_admin: false },
      { email: 'nina.analyst@newtonite.local', name: 'Nina Simone', is_org_admin: false },
    ];

    const userMap = new Map<string, string>(); // email -> id

    for (const u of usersData) {
      const res = await client.query(
        `INSERT INTO users (email, password_hash, name, is_org_admin)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, is_org_admin = EXCLUDED.is_org_admin
         RETURNING id, email`,
        [u.email, passwordHash, u.name, u.is_org_admin]
      );
      userMap.set(u.email, res.rows[0].id);
    }

    // 5. Insert Team Memberships
    const memberships = [
      // Org Admin in all teams
      { email: 'admin@newtonite.local', teamSlug: 'operations', role: 'admin' },
      { email: 'admin@newtonite.local', teamSlug: 'engineering', role: 'admin' },
      { email: 'admin@newtonite.local', teamSlug: 'payments', role: 'admin' },

      // Operations: Priya (lead), Marcus (lead), Elena (member), David (member), Sarah (viewer), Victor (member), Leila (member)
      { email: 'priya.lead@newtonite.local', teamSlug: 'operations', role: 'lead' },
      { email: 'marcus.lead@newtonite.local', teamSlug: 'operations', role: 'lead' },
      { email: 'elena.member@newtonite.local', teamSlug: 'operations', role: 'member' },
      { email: 'david.member@newtonite.local', teamSlug: 'operations', role: 'member' },
      { email: 'sarah.viewer@newtonite.local', teamSlug: 'operations', role: 'viewer' },
      { email: 'victor.ops@newtonite.local', teamSlug: 'operations', role: 'member' },
      { email: 'leila.support@newtonite.local', teamSlug: 'operations', role: 'member' },

      // Engineering: Arjun (lead), Clara (lead), Kevin (member), Aisha (member), Todd (member), Simon (viewer), Oscar (member)
      // Note: Priya is ALSO viewer in engineering (satisfying the cross-team role requirement)
      { email: 'priya.lead@newtonite.local', teamSlug: 'engineering', role: 'viewer' },
      { email: 'arjun.lead@newtonite.local', teamSlug: 'engineering', role: 'lead' },
      { email: 'clara.lead@newtonite.local', teamSlug: 'engineering', role: 'lead' },
      { email: 'kevin.member@newtonite.local', teamSlug: 'engineering', role: 'member' },
      { email: 'aisha.member@newtonite.local', teamSlug: 'engineering', role: 'member' },
      { email: 'todd.member@newtonite.local', teamSlug: 'engineering', role: 'member' },
      { email: 'simon.viewer@newtonite.local', teamSlug: 'engineering', role: 'viewer' },
      { email: 'oscar.devops@newtonite.local', teamSlug: 'engineering', role: 'member' },
      { email: 'sam.security@newtonite.local', teamSlug: 'engineering', role: 'member' },

      // Payments: Sofia (lead), Liam (lead), Zoya (member), Hassan (member), Chloe (member), Rachel (viewer), Maya (viewer), Tariq (member), Nina (viewer)
      { email: 'sofia.lead@newtonite.local', teamSlug: 'payments', role: 'lead' },
      { email: 'liam.lead@newtonite.local', teamSlug: 'payments', role: 'lead' },
      { email: 'zoya.member@newtonite.local', teamSlug: 'payments', role: 'member' },
      { email: 'hassan.member@newtonite.local', teamSlug: 'payments', role: 'member' },
      { email: 'chloe.member@newtonite.local', teamSlug: 'payments', role: 'member' },
      { email: 'rachel.viewer@newtonite.local', teamSlug: 'payments', role: 'viewer' },
      { email: 'maya.auditor@newtonite.local', teamSlug: 'payments', role: 'viewer' },
      { email: 'tariq.finance@newtonite.local', teamSlug: 'payments', role: 'member' },
      { email: 'nina.analyst@newtonite.local', teamSlug: 'payments', role: 'viewer' },
    ];

    for (const m of memberships) {
      const uId = userMap.get(m.email);
      const t = teamMap.get(m.teamSlug);
      if (uId && t) {
        await client.query(
          `INSERT INTO team_memberships (team_id, user_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [t.id, uId, m.role]
        );
      }
    }

    // 6. Generate Work Items in Batches
    const targetItems = options.itemCount;
    logger.info({ targetItems }, 'Generating work items...');

    const itemTypes = [
      'customer_issue',
      'engineering_problem',
      'payment_investigation',
      'production_incident',
      'compliance_request',
      'operational_task',
    ] as const;

    const statuses = [
      'new',
      'triaged',
      'in_progress',
      'blocked',
      'awaiting_approval',
      'resolved',
      'closed',
    ] as const;

    const priorities = ['urgent', 'high', 'medium', 'low'] as const;

    const tagsList = [
      ['p1', 'infra'],
      ['billing', 'dispute'],
      ['customer', 'sla'],
      ['security', 'audit'],
      ['api', 'latency'],
      ['database', 'deadlock'],
      ['compliance', 'gdpr'],
      ['support', 'vip'],
    ];

    const teamSlugs = ['operations', 'engineering', 'payments'];
    const teamUserIds = {
      operations: [
        userMap.get('priya.lead@newtonite.local')!,
        userMap.get('marcus.lead@newtonite.local')!,
        userMap.get('elena.member@newtonite.local')!,
        userMap.get('david.member@newtonite.local')!,
        userMap.get('victor.ops@newtonite.local')!,
      ],
      engineering: [
        userMap.get('arjun.lead@newtonite.local')!,
        userMap.get('clara.lead@newtonite.local')!,
        userMap.get('kevin.member@newtonite.local')!,
        userMap.get('aisha.member@newtonite.local')!,
        userMap.get('todd.member@newtonite.local')!,
      ],
      payments: [
        userMap.get('sofia.lead@newtonite.local')!,
        userMap.get('liam.lead@newtonite.local')!,
        userMap.get('zoya.member@newtonite.local')!,
        userMap.get('hassan.member@newtonite.local')!,
        userMap.get('chloe.member@newtonite.local')!,
      ],
    };

    const BATCH_SIZE = 1000;
    let insertedItemsCount = 0;
    const itemIdsForActivity: Array<{ id: string; reporter_id: string; team_id: string; status: string }> = [];

    // Counters per team
    const teamCounters = {
      operations: 1000,
      engineering: 1000,
      payments: 1000,
    };

    while (insertedItemsCount < targetItems) {
      const currentBatchSize = Math.min(BATCH_SIZE, targetItems - insertedItemsCount);
      const values: any[] = [];
      const rowPlaceholders: string[] = [];

      for (let i = 0; i < currentBatchSize; i++) {
        const globalIdx = insertedItemsCount + i;
        const teamSlug = teamSlugs[globalIdx % teamSlugs.length] as 'operations' | 'engineering' | 'payments';
        const team = teamMap.get(teamSlug)!;
        const users = teamUserIds[teamSlug];

        teamCounters[teamSlug]++;
        const shortRef = `${team.prefix}-${teamCounters[teamSlug]}`;

        const type = itemTypes[globalIdx % itemTypes.length];
        const status = statuses[globalIdx % statuses.length];
        const priority = priorities[globalIdx % priorities.length];

        const reporterId = users[globalIdx % users.length];
        // in_progress must have assignee as per workflow rule
        const assigneeId = (status === 'in_progress' || status === 'awaiting_approval' || (globalIdx % 3 !== 0))
          ? users[(globalIdx + 1) % users.length]
          : null;

        const requiresApproval = (type === 'compliance_request' || type === 'payment_investigation' || globalIdx % 5 === 0);
        let approvalStatus = 'not_required';
        let approvedBy: string | null = null;

        if (requiresApproval) {
          if (status === 'awaiting_approval') {
            approvalStatus = 'pending';
          } else if (status === 'resolved' || status === 'closed') {
            approvalStatus = 'approved';
            approvedBy = users[0]; // Lead
          } else {
            approvalStatus = 'pending';
          }
        }

        const resolutionNote = (status === 'resolved' || status === 'closed')
          ? `Root cause resolved via batch operational action #${globalIdx}`
          : null;

        const title = `[${team.prefix}] ${type.replace(/_/g, ' ')} investigation #${globalIdx}`;
        const description = `Operational work item opened to resolve system anomaly #${globalIdx}. Requires coordinated investigation and team action.`;
        const tags = tagsList[globalIdx % tagsList.length];
        const dueAt = new Date(Date.now() + (globalIdx % 7 - 2) * 86400000).toISOString();
        const closedAt = (status === 'closed') ? new Date().toISOString() : null;

        const pOffset = rowPlaceholders.length * 18;
        rowPlaceholders.push(`(
          $${pOffset + 1}, $${pOffset + 2}, $${pOffset + 3}, $${pOffset + 4},
          $${pOffset + 5}, $${pOffset + 6}, $${pOffset + 7}, $${pOffset + 8},
          $${pOffset + 9}, $${pOffset + 10}, $${pOffset + 11}, $${pOffset + 12},
          $${pOffset + 13}, $${pOffset + 14}, $${pOffset + 15}, $${pOffset + 16},
          $${pOffset + 17}, $${pOffset + 18}
        )`);

        values.push(
          shortRef,
          team.id,
          type,
          title,
          description,
          status,
          priority,
          reporterId,
          assigneeId,
          dueAt,
          requiresApproval,
          approvalStatus,
          approvedBy,
          resolutionNote,
          tags,
          1, // version
          new Date(Date.now() - (globalIdx % 30) * 86400000).toISOString(),
          closedAt
        );
      }

      const insertSql = `
        INSERT INTO items (
          short_ref, team_id, type, title, description, status, priority,
          reporter_id, assignee_id, due_at, requires_approval, approval_status,
          approved_by, resolution_note, tags, version, created_at, closed_at
        )
        VALUES ${rowPlaceholders.join(',')}
        RETURNING id, reporter_id, team_id, status
      `;

      const insertRes = await client.query(insertSql, values);
      for (const row of insertRes.rows) {
        if (itemIdsForActivity.length < 50000) {
          itemIdsForActivity.push(row);
        }
      }

      insertedItemsCount += currentBatchSize;
      if (insertedItemsCount % 10000 === 0 || insertedItemsCount === targetItems) {
        logger.info({ insertedItemsCount, targetItems }, 'Inserted items progress');
      }
    }

    // Update item_counter on teams to match highest counter
    for (const [slug, counter] of Object.entries(teamCounters)) {
      await client.query('UPDATE teams SET item_counter = $1 WHERE slug = $2', [counter, slug]);
    }

    // 7. Generate Activity Log in Batches
    const targetActivity = options.activityCount;
    logger.info({ targetActivity }, 'Generating activity log rows...');

    let insertedActivityCount = 0;
    const ACT_BATCH_SIZE = 2000;

    while (insertedActivityCount < targetActivity) {
      const currentBatchSize = Math.min(ACT_BATCH_SIZE, targetActivity - insertedActivityCount);
      const values: any[] = [];
      const rowPlaceholders: string[] = [];

      for (let i = 0; i < currentBatchSize; i++) {
        const globalIdx = insertedActivityCount + i;
        const item = itemIdsForActivity[globalIdx % itemIdsForActivity.length];
        const actions = ['created', 'triaged', 'assigned', 'status_changed', 'commented'];
        const action = actions[globalIdx % actions.length];

        const oldVal = action === 'status_changed' ? JSON.stringify({ status: 'triaged' }) : null;
        const newVal = action === 'status_changed' ? JSON.stringify({ status: item.status }) : null;
        const note = `Automated seed activity event #${globalIdx}`;

        const pOffset = rowPlaceholders.length * 7;
        rowPlaceholders.push(`(
          $${pOffset + 1}, $${pOffset + 2}, $${pOffset + 3}, $${pOffset + 4},
          $${pOffset + 5}, $${pOffset + 6}, $${pOffset + 7}
        )`);

        values.push(
          item.id,
          item.reporter_id,
          action,
          oldVal,
          newVal,
          note,
          new Date(Date.now() - (globalIdx % 100) * 3600000).toISOString()
        );
      }

      const actSql = `
        INSERT INTO activity_log (
          item_id, actor_id, action, old_values, new_values, note, created_at
        )
        VALUES ${rowPlaceholders.join(',')}
      `;

      await client.query(actSql, values);
      insertedActivityCount += currentBatchSize;
      if (insertedActivityCount % 50000 === 0 || insertedActivityCount === targetActivity) {
        logger.info({ insertedActivityCount, targetActivity }, 'Inserted activity log progress');
      }
    }

    // 8. Report pg_database_size
    const sizeRes = await client.query(`
      SELECT 
        pg_database_size(current_database()) as raw_size,
        pg_size_pretty(pg_database_size(current_database())) as pretty_size
    `);

    logger.info(
      {
        database: client.database,
        size: sizeRes.rows[0].pretty_size,
        rawBytes: sizeRes.rows[0].raw_size,
      },
      'Seeding completed successfully.'
    );
  } finally {
    client.release();
  }
}

// CLI argument parsing
if (process.argv[1] && (process.argv[1].endsWith('seed.ts') || process.argv[1].endsWith('seed.js'))) {
  const args = process.argv.slice(2);
  let itemCount = 50000;
  let activityCount = 500000;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--items' && args[i + 1]) {
      itemCount = parseInt(args[++i], 10);
    } else if (args[i] === '--activity' && args[i + 1]) {
      activityCount = parseInt(args[++i], 10);
    } else if (args[i] === '--force') {
      force = true;
    } else if (args[i] === '--hosted') {
      itemCount = 25000;
      activityCount = 200000;
    }
  }

  runSeed({ itemCount, activityCount, force })
    .then(() => {
      console.log(`Seeding finished. Target items: ${itemCount}, target activity: ${activityCount}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err.message);
      process.exit(1);
    });
}
