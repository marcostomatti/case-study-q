# Seed the database

Here's an example of how to seed the database with initial data using Drizzle ORM.

**Note** This example assumes you have a `users` table defined in your schema. Bun auto-loads `.env` — do NOT import `dotenv/config`.

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { usersTable } from './db/schema';

const db = drizzle(process.env.DATABASE_URL!);

async function main() {
  const user: typeof usersTable.$inferInsert = {
    name: 'John',
    age: 30,
    email: 'john@example.com',
  };

  await db.insert(usersTable).values(user);
  console.log('New user created!');
}

await main();
```

Run with:

```sh
bun scripts/seed-users.ts
```