# API Schema and Versioning strategy
Below I include a short summary and description of my interpretation of the case study requirements, as well as my proposed solution to the problem of improving collaboration between frontend and backend developers.

## Pain points and bottlenecks:
All mentioned issues can be boiled down to 3 complaints between competencies/teams:
1. Scarcity: skill to specify and support APIs is a bottleneck. PMs can't write technical detail, and junior devs need it written for them.
2. Sequencing: API definition lands too late in the software development lifecycle, which slows down frontend work.
3. Blocking: competent frontend devs sit waiting and they want parallel work.


## Hard constraints:
| Constraint          | Description                  |
| ------------------- | ---------------------------- |
| Stack               | Node.js + TypeScript (fixed) |
| Database            | Local Mock                   |
| Client-side work    | Not expected                 |
| Time budget         | 4–6 hours                    |
| Presentation + demo | 30 minutes total, combined   |

## Granted assumptions: 
- Unlimited budget (except for time budget I guess...)
- Full decision-making control, senior management backing. 
  
## My interpretation and assumptions:

- PMs role: My initial struggle was to identify the intention behind of the PM mention in the case study. I tried to identify if the PM's role was simply not relevant to the problem space, the source of the problem or a symptom. My interpretation is that:
  - PMs are the source of requirements (inter team collaboration). They are not required to provide or define low level (technical) API or data requirement.
  - PMs are not the root cause, but their potential competency gap is. They may lack the technical knowledge to describe the API implementation details for less experienced developers.

- FE devs role: The frontend developers are competent so they could understand the needed API requirements but they still need BE to implement these.

### Challenge dissection
Understanding that a challenge is only the result of an expectation meeting a reality, is the first step to resolve them. Knowing who owns the reality and who's expectations are unmet is the key to bridge the gap between both efficiently. Here's my interpretation of who owns each problem/symptom and what role they play in the argument. 

| Challenge                                          | Ownership (who's problem)   | Role                                                 |
| -------------------------------------------------- | --------------------------- | ---------------------------------------------------- |
| APIs built constantly                              | Organization                | This is the core context, and establishes the volume |
| Competence specificity for APIs                    | Senior/BE                   | Root cause                                           |
| App has no API                                     | FE                          | Symptom (this is what I'm supposed to fix)           |
| API definition happens too late                    | Planning/PM + BE            | Root cause                                           |
| PMs can't describe technical detail to junior devs | junior dev inherits from PM | Root cause                                           |
| FE devs frustrated by delays                       | FE                          | Symptom                                              |
| Want parallel work                                 | Org                         | Main Goal                                            |



## Deliverables

### Task 1: Presentation

Look [here](./PRESENTATION.md) for the presentation deliverable.

### Task 2: API Implementation
#### Database Schema and Payload Response
#### API Structure
#### Code Implementation
