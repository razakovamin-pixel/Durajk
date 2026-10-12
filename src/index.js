import { DurableObject } from "cloudflare:workers";

const RANKS = [
  ["6", 6], ["7", 7], ["8", 8], ["9", 9], ["10", 10],
  ["J", 11], ["Q", 12], ["K", 13], ["A", 14],
];
const RANK_VALUES = new Map(RANKS);
const SUITS = ["S", "H", "D", "C"];
const ROOM_RE = /^[A-Z0-9]{4,8}$/;
const PLAYER_RE = /^[a-zA-Z0-9-]{8,80}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cleanName(value) {
  return String(value || "Игрок").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 20) || "Игрок";
}

function safeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const [rank, value] of RANKS) deck.push({ id: `${rank}${suit}`, rank, value, suit });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function createLobby(room) {
  return {
    room,
    players: [],
    hostId: null,
    started: false,
    gameOver: false,
    winnerId: null,
    draw: false,
    deck: [],
    trumpSuit: null,
    table: [],
    attackerId: null,
    defenderId: null,
    attackLimit: 0,
    phase: "waiting",
    cheats: {},
  };
}

// deck[0] is the visible trump card and is drawn last.
function drawCard(game) {
  if (!game.deck.length) return null;
  return game.deck.length === 1 ? game.deck.shift() : game.deck.pop();
}

function drawToSix(game, player) {
  if (!player) return;
  while (player.hand.length < 6 && game.deck.length) {
    const card = drawCard(game);
    if (card) player.hand.push(card);
  }
}

function startGame(game) {
  if (game.players.length !== 2) return;
  game.deck = makeDeck();
  game.trumpSuit = game.deck[0].suit;
  for (const player of game.players) player.hand = [];
  for (let i = 0; i < 6; i++) {
    for (const player of game.players) {
      const card = drawCard(game);
      if (card) player.hand.push(card);
    }
  }

  const lowestTrumps = game.players.map((player) => {
    const trumps = player.hand.filter((card) => card.suit === game.trumpSuit);
    return trumps.length ? Math.min(...trumps.map((card) => card.value)) : Infinity;
  });
  if (lowestTrumps[0] === lowestTrumps[1]) {
    game.attackerId = game.players[Math.floor(Math.random() * 2)].id;
  } else {
    game.attackerId = game.players[lowestTrumps[0] < lowestTrumps[1] ? 0 : 1].id;
  }
  game.defenderId = game.players.find((player) => player.id !== game.attackerId).id;
  game.attackLimit = findPlayer(game, game.defenderId).hand.length;
  game.table = [];
  game.started = true;
  game.gameOver = false;
  game.winnerId = null;
  game.draw = false;
  game.phase = "attack";
  game.cheats = {};
}

function beats(defense, attack, trumpSuit) {
  if (defense.suit === attack.suit) return defense.value > attack.value;
  return defense.suit === trumpSuit && attack.suit !== trumpSuit;
}

function findPlayer(game, playerId) {
  return game.players.find((player) => player.id === playerId);
}

function checkGameOver(game) {
  if (game.deck.length !== 0) return;
  const emptyPlayers = game.players.filter((player) => player.hand.length === 0);
  if (!emptyPlayers.length) return;
  game.gameOver = true;
  game.phase = "over";
  if (emptyPlayers.length === 2) {
    game.draw = true;
    game.winnerId = null;
  } else {
    game.draw = false;
    game.winnerId = emptyPlayers[0].id;
  }
}

function finishRound(game, wasTaken = false) {
  const attacker = findPlayer(game, game.attackerId);
  const defender = findPlayer(game, game.defenderId);
  if (!attacker || !defender) return;

  if (wasTaken) {
    for (const item of game.table) {
      defender.hand.push(item.attack);
      if (item.defense) defender.hand.push(item.defense);
    }
  }
  game.table = [];

  // Draw order is the original attacker, then the original defender.
  drawToSix(game, attacker);
  drawToSix(game, defender);

  // If the defender picked up the cards, the same attacker attacks again.
  // If every card was beaten, the roles switch for the next round.
  if (!wasTaken) {
    game.attackerId = defender.id;
    game.defenderId = attacker.id;
  }
  game.attackLimit = findPlayer(game, game.defenderId)?.hand.length || 0;
  game.phase = "attack";
  checkGameOver(game);
}

function cardLabel(card) {
  return `${card.rank}${card.suit}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").toUpperCase();
      if (!ROOM_RE.test(room)) {
        return json({ error: "Код комнаты должен содержать 4–8 латинских букв или цифр." }, 400);
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ error: "Для игрового соединения нужен WebSocket." }, 426);
      }
      const id = env.DURAK_ROOMS.idFromName(`durak:${room}`);
      return env.DURAK_ROOMS.get(id).fetch(request);
    }
    if (url.pathname === "/health") return json({ ok: true, service: "durak-online" });
    return env.ASSETS.fetch(request);
  },
};

export class DurakRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.game = null;
    this.loaded = false;
    this.loading = null;
    this.room = null;
  }

  async load(roomFromUrl = null) {
    if (this.loaded) {
      if (roomFromUrl) this.room = roomFromUrl;
      return;
    }
    if (!this.loading) {
      this.loading = (async () => {
        this.game = await this.ctx.storage.get("game") || createLobby(roomFromUrl || "ROOM");
        this.room = roomFromUrl || this.game.room || "ROOM";
        this.loaded = true;
      })();
    }
    await this.loading;
    if (roomFromUrl) this.room = roomFromUrl;
  }

  async save() {
    this.game.room = this.room || this.game.room;
    await this.ctx.storage.put("game", this.game);
  }

  activePlayerIds() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment = ws.deserializeAttachment();
        if (attachment?.playerId) ids.add(attachment.playerId);
      } catch (_) {}
    }
    return ids;
  }

  async isConfiguredCheater(playerId) {
    if (!this.env.DB || !playerId) return false;
    try {
      const result = await this.env.DB.prepare(
        "SELECT player_id FROM cheat_authorized_players WHERE player_id = ? AND enabled = 1 LIMIT 1"
      ).bind(playerId).first();
      return Boolean(result?.player_id);
    } catch (error) {
      console.error("D1 cheat authorization lookup failed:", error);
      return false;
    }
  }

  canUseCheats(ws, playerId) {
    let attachment;
    try { attachment = ws.deserializeAttachment(); } catch (_) { attachment = null; }
    // The current D1 authorization is refreshed before each cheat command; this checks
    // the server-managed connection authorization and active toggle.
    return attachment?.isConfiguredCheater === true &&
      attachment?.cheatAuthorized === true &&
      this.game.cheats[playerId] === true;
  }

  snapshot(playerId, onlineIds, attachment = {}) {
    const game = this.game;
    const me = findPlayer(game, playerId);
    const opponent = game.players.find((player) => player.id !== playerId);
    const isCheater = attachment.isConfiguredCheater === true;
    const cheatAuthorized = isCheater && attachment.cheatAuthorized === true;
    const cheatEnabled = cheatAuthorized && game.cheats[playerId] === true;
    return {
      type: "state",
      room: game.room,
      myId: playerId,
      isHost: game.hostId === playerId,
      canCheat: isCheater,
      cheatAuthorized,
      players: game.players.map((player) => ({
        id: player.id,
        name: player.name,
        handCount: player.hand.length,
        online: onlineIds.has(player.id),
      })),
      hand: me?.hand || [],
      // The opponent's hand is only serialized to the authenticated, configured ID while cheats are on.
      ...(cheatEnabled ? { opponentHand: opponent?.hand || [] } : {}),
      cheatEnabled,
      started: game.started,
      gameOver: game.gameOver,
      winnerId: game.winnerId,
      draw: game.draw,
      deckCount: game.deck.length,
      trumpCard: game.deck.length ? game.deck[0] : null,
      trumpSuit: game.trumpSuit,
      table: game.table,
      attackerId: game.attackerId,
      defenderId: game.defenderId,
      attackLimit: game.attackLimit,
      phase: game.phase,
    };
  }

  send(ws, message) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    } catch (_) {}
  }

  broadcast() {
    const onlineIds = this.activePlayerIds();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment = ws.deserializeAttachment();
        if (attachment?.playerId) {
          this.send(ws, this.snapshot(attachment.playerId, onlineIds, attachment));
        }
      } catch (_) {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = (url.searchParams.get("room") || "").toUpperCase();
    await this.load(room);
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "Для игрового соединения нужен WebSocket." }, 426);
    }

    const playerId = url.searchParams.get("pid") || "";
    if (!PLAYER_RE.test(playerId)) return json({ error: "Некорректный идентификатор игрока." }, 400);
    const name = cleanName(url.searchParams.get("name"));
    const isConfiguredCheater = await this.isConfiguredCheater(playerId);
    let player = findPlayer(this.game, playerId);
    if (!player && this.game.players.length >= 2) {
      return json({ type: "error", error: "Эта комната уже заполнена двумя игроками." }, 409);
    }

    if (!player) {
      player = { id: playerId, name, hand: [] };
      this.game.players.push(player);
      if (!this.game.hostId) this.game.hostId = playerId;
    } else {
      player.name = name;
    }

    if (this.game.players.length === 2 && !this.game.started) startGame(this.game);
    await this.save();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [`player:${playerId}`]);
    const attachment = { playerId, isConfiguredCheater, cheatAuthorized: false };
    server.serializeAttachment(attachment);
    this.send(server, this.snapshot(playerId, this.activePlayerIds(), attachment));
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.load();
    let attachment;
    try { attachment = ws.deserializeAttachment(); } catch (_) { attachment = null; }
    const playerId = attachment?.playerId;
    if (!playerId) return;

    let data;
    try {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (raw.length > 4096) throw new Error("Команда слишком большая.");
      data = JSON.parse(raw);
    } catch (_) {
      this.send(ws, { type: "error", error: "Не удалось прочитать команду." });
      return;
    }

    const game = this.game;
    const player = findPlayer(game, playerId);
    if (!player) return;

    try {
      switch (data.type) {
        case "cheat_toggle": {
          const isConfiguredCheater = await this.isConfiguredCheater(playerId);
          if (!isConfiguredCheater) {
            attachment = { ...attachment, isConfiguredCheater: false, cheatAuthorized: false };
            ws.serializeAttachment(attachment);
            delete game.cheats[playerId];
            throw new Error("Чит-режим недоступен для этого ID (проверьте D1).");
          }
          attachment = { ...attachment, isConfiguredCheater: true };
          if (attachment.cheatAuthorized !== true) {
            const suppliedToken = typeof data.token === "string" ? data.token.slice(0, 256) : "";
            if (!this.env.CHEATER_TOKEN) throw new Error("На сервере не настроен CHEATER_TOKEN.");
            if (!safeEqual(suppliedToken, this.env.CHEATER_TOKEN)) throw new Error("Неверный секретный ключ чит-режима.");
            attachment = { ...attachment, cheatAuthorized: true };
            ws.serializeAttachment(attachment);
            game.cheats[playerId] = true;
          } else {
            game.cheats[playerId] = game.cheats[playerId] !== true;
          }
          break;
        }
        case "cheat_replace_card": {
          if (!(await this.isConfiguredCheater(playerId))) {
            attachment = { ...attachment, isConfiguredCheater: false, cheatAuthorized: false };
            ws.serializeAttachment(attachment);
            delete game.cheats[playerId];
            throw new Error("ID больше не разрешён в D1.");
          }
          if (!this.canUseCheats(ws, playerId)) throw new Error("Сначала включите чит-режим на разрешённом ID.");
          const rank = String(data.rank || "");
          const suit = String(data.suit || "");
          const ownCardId = String(data.ownCardId || "");
          if (!RANK_VALUES.has(rank) || !SUITS.includes(suit)) throw new Error("Некорректная карта для замены.");
          const replacementId = `${rank}${suit}`;
          if (replacementId === ownCardId) throw new Error("Вы уже выбрали эту карту.");
          const ownIndex = player.hand.findIndex((card) => card.id === ownCardId);
          if (ownIndex < 0) throw new Error("Выбранной карты больше нет у вас на руках.");
          const opponent = game.players.find((entry) => entry.id !== playerId);
          const opponentIndex = opponent?.hand.findIndex((card) => card.id === replacementId) ?? -1;
          const deckIndex = game.deck.findIndex((card) => card.id === replacementId);
          const replacementCard = opponentIndex >= 0 ? opponent.hand[opponentIndex] : game.deck[deckIndex];
          if (!replacementCard) {
            throw new Error("Этой карты нет в колоде или руке соперника (возможно, она уже на столе или у вас).");
          }
          const oldCard = player.hand[ownIndex];
          player.hand[ownIndex] = replacementCard;
          if (opponentIndex >= 0) {
            opponent.hand[opponentIndex] = oldCard;
          } else {
            game.deck[deckIndex] = oldCard;
            if (deckIndex === 0) game.trumpSuit = game.deck[0].suit;
          }
          break;
        }
        case "cheat_give_trump": {
          if (!(await this.isConfiguredCheater(playerId))) {
            attachment = { ...attachment, isConfiguredCheater: false, cheatAuthorized: false };
            ws.serializeAttachment(attachment);
            delete game.cheats[playerId];
            throw new Error("ID больше не разрешён в D1.");
          }
          if (!this.canUseCheats(ws, playerId)) throw new Error("Сначала включите чит-режим на разрешённом ID.");
          if (!player.hand.length) throw new Error("У вас нет карты, которую можно обменять.");
          if (!game.trumpSuit) throw new Error("Козырь ещё не определён.");
          const requestedOwnCardId = String(data.ownCardId || "");
          let ownIndex = player.hand.findIndex((card) => card.id === requestedOwnCardId);
          if (ownIndex < 0) throw new Error("Выберите карту, которую хотите обменять.");
          // Prefer a hidden trump in the deck so the visible bottom card does not change.
          let deckIndex = game.deck.findIndex((card, index) => index > 0 && card.suit === game.trumpSuit);
          const opponent = game.players.find((entry) => entry.id !== playerId);
          let opponentIndex = -1;
          if (deckIndex < 0) opponentIndex = opponent?.hand.findIndex((card) => card.suit === game.trumpSuit) ?? -1;
          if (deckIndex < 0 && opponentIndex < 0 && game.deck[0]?.suit === game.trumpSuit) deckIndex = 0;
          if (deckIndex < 0 && opponentIndex < 0) throw new Error("Не осталось доступных козырей для обмена.");

          const oldCard = player.hand[ownIndex];
          if (deckIndex >= 0) {
            const trumpCard = game.deck[deckIndex];
            player.hand[ownIndex] = trumpCard;
            game.deck[deckIndex] = oldCard;
            if (deckIndex === 0) game.trumpSuit = game.deck[0].suit;
          } else {
            const trumpCard = opponent.hand[opponentIndex];
            player.hand[ownIndex] = trumpCard;
            opponent.hand[opponentIndex] = oldCard;
          }
          break;
        }
        case "restart": {
          if (game.hostId !== playerId) throw new Error("Перезапустить партию может создатель комнаты.");
          if (game.players.length !== 2) throw new Error("Нужны два игрока для новой партии.");
          startGame(game);
          break;
        }
        case "attack": {
          if (!game.started || game.gameOver) throw new Error("Партия сейчас не идёт.");
          if (playerId !== game.attackerId) throw new Error("Сейчас атакует соперник.");
          if (!["attack", "throw"].includes(game.phase)) throw new Error("Сначала отбейте текущие карты или заберите их.");
          if (game.table.length >= game.attackLimit) throw new Error("Больше подкидывать нельзя.");
          const cardIndex = player.hand.findIndex((card) => card.id === data.cardId);
          if (cardIndex < 0) throw new Error("Этой карты нет у вас на руках.");
          const card = player.hand[cardIndex];
          if (game.table.length > 0) {
            const ranksOnTable = new Set();
            for (const item of game.table) {
              ranksOnTable.add(item.attack.rank);
              if (item.defense) ranksOnTable.add(item.defense.rank);
            }
            if (!ranksOnTable.has(card.rank)) throw new Error("Можно подкинуть только карту с рангом, который уже есть на столе.");
          }
          player.hand.splice(cardIndex, 1);
          game.table.push({ id: crypto.randomUUID(), attack: card, defense: null });
          game.phase = "defend";
          break;
        }
        case "defend": {
          if (!game.started || game.gameOver) throw new Error("Партия сейчас не идёт.");
          if (playerId !== game.defenderId) throw new Error("Сейчас отбивается соперник.");
          if (game.phase !== "defend") throw new Error("Сейчас нечего отбивать.");
          const target = game.table.find((item) => item.id === data.tableId && !item.defense)
            || game.table.find((item) => !item.defense);
          if (!target) throw new Error("Все карты уже отбиты.");
          const cardIndex = player.hand.findIndex((card) => card.id === data.cardId);
          if (cardIndex < 0) throw new Error("Этой карты нет у вас на руках.");
          const card = player.hand[cardIndex];
          if (!beats(card, target.attack, game.trumpSuit)) throw new Error("Эта карта не бьёт выбранную карту.");
          player.hand.splice(cardIndex, 1);
          target.defense = card;
          game.phase = game.table.every((item) => item.defense) ? "throw" : "defend";
          break;
        }
        case "take": {
          if (!game.started || game.gameOver) throw new Error("Партия сейчас не идёт.");
          if (playerId !== game.defenderId) throw new Error("Забрать карты может только отбивающийся.");
          if (!["defend", "throw"].includes(game.phase) || game.table.length === 0) throw new Error("Сейчас нечего забирать.");
          finishRound(game, true);
          break;
        }
        case "beat": {
          if (!game.started || game.gameOver) throw new Error("Партия сейчас не идёт.");
          if (playerId !== game.attackerId) throw new Error("Завершить ход может атакующий.");
          if (game.phase !== "throw" || !game.table.length || !game.table.every((item) => item.defense)) {
            throw new Error("Сначала отбейте все карты.");
          }
          finishRound(game, false);
          break;
        }
        default:
          throw new Error("Неизвестная команда.");
      }
      await this.save();
      this.broadcast();
    } catch (error) {
      this.send(ws, { type: "error", error: error?.message || "Команда отклонена." });
    }
  }

  async webSocketClose() {
    await this.load();
    this.broadcast();
  }

  async webSocketError() {
    await this.load();
    this.broadcast();
  }
}
