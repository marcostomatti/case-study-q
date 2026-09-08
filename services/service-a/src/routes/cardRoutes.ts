/**
 * The one state change this contract publishes: activating the card the
 * cardholder is holding.
 *
 * It follows the same four steps as the reads in `./companyRoutes` — name the
 * operation, check the request against the contract, refuse an identifier this
 * provider could not have issued, then read, map and answer — and adds the two
 * things a write has that a read does not.
 *
 * ## Why the card is read before it is written
 *
 * `activateCard` in the repository layer returns `null` for three situations
 * it deliberately cannot tell apart: no such card, a card belonging to another
 * company, and a card in a state that cannot be activated. The contract
 * distinguishes the last one — `409` rather than `404` — because a cardholder
 * double-tapping the button is a different thing to say than a broken link. So
 * this route reads first, to know which answer to give, and the repository
 * keeps its guard in the `UPDATE`'s `WHERE` clause anyway.
 *
 * That guard is what makes the read safe rather than a check-then-act race.
 * Between the read and the write another request can activate the same card;
 * the write then matches nothing and this route answers the second caller
 * `409`, instead of both callers getting `200` and the first activation's
 * `activated_at` being overwritten. The `null` after a successful read is
 * therefore a real outcome with its own answer, not a defensive branch.
 *
 * ## The last-four check is a possession check, not an authorisation one
 *
 * The caller is already authenticated and already scoped to the company, and
 * `confirmedLastFour` is the cardholder reading four digits off a piece of
 * plastic. A mismatch is answered `400` naming the field, which is what lets
 * the app re-prompt the same input rather than sending the user back a screen.
 * It is compared as an ordinary string: the digits are printed on the card the
 * caller is holding, not a secret, and a constant-time compare would imply
 * this decides access. It does not — `activateCard` does.
 */
import type { RouteDependencies } from './dependencies';

import { contract } from '@marcos-corp/contracts-service-a';
import { initServer } from '@ts-rest/express';

import { toContractCard } from '../mapping/cardMapper';
import { activateCard, findCardById } from '../repositories/cardRepository';
import { recordOperation } from '../telemetry/usageLogger';

import {
  CONFLICT_STATUS,
  conflict,
  NOT_FOUND_STATUS,
  notFound,
  VALIDATION_FAILED_STATUS,
  validationFailed,
} from './errors';
import { isIssuedIdentifier, parseRequestPayload } from './requestParsing';

const server = initServer();

/** The request field a mismatch is reported against, as the contract spells it. */
const CONFIRMED_LAST_FOUR_FIELD = 'confirmedLastFour';

/**
 * Activate a card, and answer with the card as it now is.
 *
 * `200` with the updated card rather than `201` with an activation record: the
 * card is what the screen re-renders, and the activation is the provider's
 * bookkeeping.
 */
export function activateCardRoute(deps: RouteDependencies) {
  return server.route(contract.activateCard, async ({ params, body, req }) => {
    recordOperation(req, 'activateCard');

    const parsedParams = parseRequestPayload(contract.activateCard.pathParams, params);
    if (!parsedParams.ok) {
      return { status: VALIDATION_FAILED_STATUS, body: parsedParams.error };
    }

    const parsedBody = parseRequestPayload(contract.activateCard.body, body);
    if (!parsedBody.ok) {
      return { status: VALIDATION_FAILED_STATUS, body: parsedBody.error };
    }

    const { companyId, cardId } = parsedParams.value;
    if (!isIssuedIdentifier(companyId) || !isIssuedIdentifier(cardId)) {
      return { status: NOT_FOUND_STATUS, body: notFound(missingCard(cardId)) };
    }

    const card = await findCardById(deps.db, { companyId, cardId });
    if (card === null) {
      return { status: NOT_FOUND_STATUS, body: notFound(missingCard(cardId)) };
    }

    if (card.panLastFour !== parsedBody.value.confirmedLastFour) {
      return {
        status: VALIDATION_FAILED_STATUS,
        body: validationFailed(
          `${CONFIRMED_LAST_FOUR_FIELD} does not match the card being activated`,
          [CONFIRMED_LAST_FOUR_FIELD],
        ),
      };
    }

    const activated = await activateCard(deps.db, {
      companyId,
      cardId,
      activatedAt: deps.now(),
    });

    if (activated === null) {
      return {
        status: CONFLICT_STATUS,
        body: conflict(
          `card '${cardId}' is not in a state that can be activated. Its state is `
          + 'already past activation, or another request activated it first.',
        ),
      };
    }

    return { status: 200, body: toContractCard(activated, deps.cardMapping) };
  });
}

/**
 * The sentence both `404` branches answer with.
 *
 * Names the card rather than the company, because the card is what the caller
 * addressed. It does not distinguish "no such card" from "not this company's
 * card" — the catalogue folds those onto one code precisely so that an
 * unauthorised caller cannot enumerate identifiers by reading the difference,
 * and the wording has to fold them too or it hands back what the code withheld.
 */
function missingCard(cardId: string): string {
  return `service-a holds no card '${cardId}' for this caller`;
}
