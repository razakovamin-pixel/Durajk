import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Replace Cloudflare's runtime-only base class with a tiny test double so the
// Durable Object message handler can be tested using plain Node.js.
const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(
  'import { DurableObject } from "cloudflare:workers";',
  "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
);
if (source.includes('from "cloudflare:workers"')) {
  throw new Error("Could not replace Cloudflare-only import for the local test harness.");
}
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { DurakRoom } = await import(moduleUrl);
globalThis.WebSocket = { OPEN: 1 };

const ADMIN_ID = "admin-player-id-123456";
const OTHER_ID = "opponent-player-id-123";
const TOKEN = "test-secret-token";
const card = (id, rank, value, suit) => ({ id, rank, value, suit });
const player = (id, hand) => ({ id, name: id, hand });

function makeGame({ phase = "attack", table = [], attackerId = ADMIN_ID, defenderId = OTHER_ID } = {}) {
  return {
    room: "TEST",
    players: [
      player(ADMIN_ID, [card("6C", "6", 6, "C"), card("9D", "9", 9, "D")]),
      player(OTHER_ID, [card("7S", "7", 7, "S"), card("JH", "J", 11, "H")]),
    ],
    hostId: OTHER_ID,
    started: true,
    gameOver: false,
    winnerId: null,
    draw: false,
    deck: [card("6S", "6", 6, "S"), card("AS", "A", 14, "S"), card("10H", "10", 10, "H")],
    trumpSuit: "S",
    table,
    attackerId,
    defenderId,
    attackLimit: 6,
    phase,
    cheats: {},
  };
}

const stored = new Map();
const sockets = [];
const ctx = {
  storage: {
    get: async (key) => stored.get(key),
    put: async (key, value) => stored.set(key, structuredClone(value)),
  },
  getWebSockets: () => sockets,
};
const authorizedIds = new Set([ADMIN_ID]);
const DB = {
  prepare() {
    return {
      bind(playerId) {
        return { first: async () => authorizedIds.has(playerId) ? { player_id: playerId } : null };
      },
    };
  },
};
const room = new DurakRoom(ctx, { DB, CHEATER_TOKEN: TOKEN });
room.loaded = true;
room.room = "TEST";
room.game = makeGame();
function fakeSocket(id) {
  return {
    readyState: 1,
    attachment: { playerId: id, isConfiguredCheater: id === ADMIN_ID, cheatAuthorized: false },
    messages: [],
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value) { this.attachment = structuredClone(value); },
    send(value) { this.messages.push(JSON.parse(value)); },
  };
}
const adminSocket = fakeSocket(ADMIN_ID);
const opponentSocket = fakeSocket(OTHER_ID);
sockets.push(adminSocket, opponentSocket);

await room.webSocketMessage(adminSocket, JSON.stringify({ type: "cheat_toggle", token: "wrong" }));
assert.equal(adminSocket.messages.at(-1).type, "error", "wrong token must be rejected");
assert.equal(adminSocket.attachment.cheatAuthorized, false);
await room.webSocketMessage(opponentSocket, JSON.stringify({ type: "cheat_toggle", token: TOKEN }));
assert.equal(opponentSocket.messages.at(-1).type, "error", "another ID must be denied even with the right token");

await room.webSocketMessage(adminSocket, JSON.stringify({ type: "cheat_toggle", token: TOKEN }));
assert.equal(adminSocket.attachment.cheatAuthorized, true);
assert.equal(room.game.cheats[ADMIN_ID], true);
assert.ok(adminSocket.messages.at(-1).opponentHand?.length, "authorized cheater should see opponent cards");
assert.equal(Object.hasOwn(opponentSocket.messages.at(-1), "opponentHand"), false, "opponent cards must not leak to the other player");

await room.webSocketMessage(adminSocket, JSON.stringify({ type: "cheat_replace_card", ownCardId: "6C", rank: "A", suit: "S" }));
assert.equal(room.game.players[0].hand[0].id, "AS", "selected card should be replaced");
assert.equal(room.game.deck[1].id, "6C", "replaced card should be returned to the source position");
const activeCards = [
  ...room.game.players.flatMap((entry) => entry.hand),
  ...room.game.deck,
  ...room.game.table.flatMap((entry) => [entry.attack, entry.defense].filter(Boolean)),
];
assert.equal(new Set(activeCards.map((entry) => entry.id)).size, activeCards.length, "replacement must not create duplicate cards");

await room.webSocketMessage(adminSocket, JSON.stringify({ type: "cheat_give_trump", ownCardId: "9D" }));
assert.ok(room.game.players[0].hand.some((entry) => entry.id === "7S"), "trump should be exchanged into the configured player's hand");
assert.ok(room.game.players[1].hand.some((entry) => entry.id === "9D"), "selected card should be exchanged back to the opponent");

room.game = makeGame({
  phase: "defend",
  attackerId: ADMIN_ID,
  defenderId: OTHER_ID,
  table: [{ id: "t", attack: card("8H", "8", 8, "H"), defense: null }],
});
room.game.players[0].hand = [card("6C", "6", 6, "C")];
room.game.players[1].hand = [card("7S", "7", 7, "S"), card("JH", "J", 11, "H")];
await room.webSocketMessage(opponentSocket, JSON.stringify({ type: "take" }));
assert.equal(room.game.attackerId, ADMIN_ID, "same attacker must continue after the defender takes cards");
assert.equal(room.game.defenderId, OTHER_ID);

room.game = makeGame({
  phase: "throw",
  attackerId: ADMIN_ID,
  defenderId: OTHER_ID,
  table: [{ id: "t", attack: card("8H", "8", 8, "H"), defense: card("9H", "9", 9, "H") }],
});
await room.webSocketMessage(adminSocket, JSON.stringify({ type: "beat" }));
assert.equal(room.game.attackerId, OTHER_ID, "roles must switch after a successful defense");
assert.equal(room.game.defenderId, ADMIN_ID);

console.log("Server tests passed: cheat ID/token authorization, private opponent-hand visibility, card replacement, trump exchange, and turn-role rules.");
