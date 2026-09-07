# Setup a Drizzle config file

Drizzle config - a configuration file that is used by [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview) and contains all the information about your database connection, migration folder and schema files.

Example of a `drizzle.config.ts` file in the root of your project and add the following content:
```ts
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});

```