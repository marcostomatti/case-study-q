# Presentation

## Inital Thought process

1. Allowing other teams to define API Schemas is the cheapest and long-term solution. But interferes directly with data/API/Schema ownership.
2. BE teams own the API and data models, but its definitions are essentially external inputs. This needs to be represented as part of the solution and not as a problem to solve.
3. Solution should solve this problem and any future inter-team collaboration problem. So we need to expand the problem space (case study definition) within a reasonable scope to address scalability, sustainability and future-proofing:
   - New API consumers appear without the provider team being consulted. Eg: Another app, other aggregation service, 3rd party integration, etc
   - Producer and consumer velocity differ. eg: Same problem as now, but the ownership shifts with our current BE team being a consumer of another BE api instead of the producer. 
4. This is a control and governance problem, not just inter-team collaboration and communication problem. Soft guidelines always result in divergence, duplication and conflicts in operations short to mid term. 
5. Challenging previous divergence assumptions as it is not a problem per se. It is the cost of independent deployability (reason to break down monoliths). Stopping divergence is return to a monolithic (although distributed) architecture . So we need to embrace divergence, but control it.


## Solution: Governance and enforcing control mechanisms 

### Governance 

Before defining control tools or enforcing mechanism/rituals we need to break down the ownership and coordination cost tiers for our contracts. 

##### Tier 0: unilateral/local, no consumers.
DB schemas and internal type definitions are owned by the team and can be changed at will. No external consumers exist, so no coordination is needed.
- Catches structural breaks. Removed fields, narrowed types, new required request fields, tightened enums, changed status codes.
- Misses everything semantic. A field keeps its type and changes meaning. eg: An enum value's behaviour changes. null starts arriving where it never did.
- Ownership belongs to team or Staff/Lead Eng. In short, someone must own the ruleset for "what counts as breaking".
- Low chances of failure in production. If tooling runs and covers types effectively it should't fail loudly.
- Iterative improvements should be implemented. Logging and recording traffic replay captures serialization changes, semantic drift, shapes/ordering changes, etc. 

##### Tier 1: unilateral, with potential consumers
Not necessarily a use case in our case study until we introduce control tools for bug reports, telemtry and general event logging (interlan or external). In this scenario a tool or external service becomes a consumer of the internal service state and data flow, but not of our exposed APIs. 
In the given example, this is probably the tier where the exposed API contracts currently live. 

##### Tier 2: bilateral, with low ceremony.
This is the current scenario level, in a consumer-driven, but producer written contract. Ideal progression would allow consumer to write contracts but producer to approve and enforce them. This is a common pattern in microservices, and is the most cost-effective solution for inter-team collaboration. There's a caveat when leveraging tools that automatically generate specs without manual intervention. They don't drift but they will leak implementation shape (an ORM column name becomes a public contract, and then they're exposed and load-bearing props).
- Catches current expected consumer contract violations. eg: A consumer expects a field to be present, but the provider has removed it or type differs from the expected type.
- Misses unexpected consumer contract violations. Given that coverage is an assertion coverage, not a contract coverage, this is an unmeasurable gap if specs misses a field, or if the spec is wrong.
- Human are still the main source of drift as control remains internal and manual. Eg: A classic scenario is that a consumer/provider pact blocks a hotfix at 2am; someone adds an ignore-like patch rule. The ignore is never removed; six months later half the pacts are stale and nobody knows which half. Once the bypass is normalized, the system is decorative but still costs full price in CI minutes and ceremony.

##### Tier 3: bilateral, infrastructural
Schema registry with compatibility modes (eg: backward, forward, full) and/or versioning. This is not recommended if we have a low number of consumers (< 5) and a low number of producers (< 5). A registry first approach wouldn't be an ideal suggestion in most situations, but the cas study given problem space / industry. It is highly regulated, requires strict compliance and audits.
- Catches mechanical compatibility, centrally, at registration time, for every producer at once. Eg: A consumer proposes a type change on a field is rejected immediately by the registry without the producer having to implement it and test it.
- Ownership remains as is. Teams own their schemas, but the registry enforces the ruleset. The registry is a central authority that can be used to enforce rules and ensure that all teams are following the same guidelines.

##### Tier 4: organizational level
This is the highest level of governance. It falls into the domain of an API review board, which is a cross-functional team that reviews and approves API changes before they are implemented. This ensures that all teams are aligned on the API design and that any potential conflicts are resolved before they become issues. This is mostly required for exposed APIs with an unknown number of public consumers. It falls outside of the scope of this case study but previous tiers organization highly simplify the work and implementation of this tier.

##### Summary
- Tier 0 is a standard operation procedure for any team. 
- Current scenario has a situation where tier 2 is currently at a tier 1 level, where ownership and control is exclusively owned by the producer team and an internal feature of the service.
- First iteration implementation should allow tier 2 to be implemented with controls that allow external definitions with internal approval, control and enforcement.
- Further iterations should aim to implement tier 3. Keeping ownership of schemas and basic control as defined in team 2. External definitions can be proposed and approved by the producer team, but introducing a registry with heavier enforcement and control mechanisms.
- Wiring between tiers should not be tool based (fully auto generated specs). This prevents leaking/persisting internal implementation details, or even mistakes.


#### Control mechanisms

> [!note] Stack assumed: TypeScript/Node + PostgreSQL + DrizzleORM. 
> The decision to include **DrizzleORM** is for illustrative purposes mostly. This ORM library was picked as it is an industry standard library as it produced highly typed data specs based on DB schema definitions. In this scenario it introduces a conflict point, whenever an internal data spec definition is deferred to the ORM, API schemas should prevent leakage of db level definitions as well as control tools should cover mismatch and missing wiring between auto generated types/schemas. 

