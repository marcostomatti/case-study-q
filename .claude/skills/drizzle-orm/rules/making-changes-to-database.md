# Making changes to a database



## Migrations
You can generate migrations using the `drizzle-kit generate` command and then apply them using the `drizzle-kit migrate` command:

Generate migrations:

bunx drizzle-kit generate

Apply migrations:

bunx drizzle-kit migrate

**Note** more about migration process in [documentation](https://orm.drizzle.team/docs/kit-overview).


## Apply changes 
You can directly apply changes to your database using the `drizzle-kit push` command. This is a convenient method for quickly testing new schema designs or modifications in a local development environment, allowing for rapid iterations without the need to manage migration files:

```sh
bunx drizzle-kit push

```
