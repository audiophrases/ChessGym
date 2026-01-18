/*
  ChessGym uses four CSV feeds:
  - openings: core opening metadata (opening_id, starting_fen, book_max_plies_game_mode, etc.).
  - lines: named training lines (opening_id, line_id, drill_side, start_fen, moves_pgn).
  - moves: per-ply instructions for each line (move_uci, accept_uci, prompts, feedback, mistake_map).
  - mistake_templates: global messaging for mapped mistakes (mistake_code -> coach_message, why_wrong, hint).
*/

const OPENINGS_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=0&single=true&output=csv";
const LINES_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=10969022&single=true&output=csv";
const MOVES_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=1261107814&single=true&output=csv";
const MISTAKE_TEMPLATES_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=1251282566&single=true&output=csv";

const App = {
  data: {
    openings: [],
    lines: [],
    moves: [],
    mistakeTemplates: [],
    openingsById: {},
    linesByOpeningId: {},
    movesByLineId: {},
    mistakeTemplatesByCode: {}
  },
  state: {
    mode: "learning",
    openingId: null,
    lineId: null,
    userSide: "white",
    currentLineMoves: [],
    currentPlyIndex: 0,
    mistakes: 0,
    hintLevel: 0,
    completed: false,
    inBook: false,
    bookLineMoves: [],
    bookPlyIndex: 0,
    bookMaxPlies: 0,
    engineReady: false,
    engineBusy: false
  },
  chess: null,
  board: null,
  engine: null,
  sounds: {},
  init() {
    this.cacheElements();
    this.bindEvents();
    this.showLoading(true);
    this.loadData();
  },
  cacheElements() {
    this.$opening = $("#openingSelect");
    this.$line = $("#lineSelect");
    this.$mode = $("#modeSelect");
    this.$side = $("#sideSelect");
    this.$strength = $("#strengthSelect");
    this.$start = $("#startBtn");
    this.$reset = $("#resetBtn");
    this.$status = $("#statusText");
    this.$lineStatus = $("#lineStatus");
    this.$progress = $("#progressInfo");
    this.$comment = $("#commentBox");
    this.$hint = $("#hintBtn");
    this.$moveList = $("#moveList");
    this.$engineEval = $("#engineEval");
    this.$overlay = $("#loadingOverlay");
    this.$strengthField = $("#strengthField");
  },
  bindEvents() {
    this.$opening.on("change", () => this.onOpeningChange());
    this.$line.on("change", () => this.onLineChange());
    this.$mode.on("change", () => this.onModeChange());
    this.$side.on("change", () => this.onSideChange());
    this.$strength.on("change", () => this.onStrengthChange());
    this.$start.on("click", () => this.startSession());
    this.$reset.on("click", () => this.resetSession());
    this.$hint.on("click", () => this.handleHint());
  },
  showLoading(isLoading, message) {
    if (isLoading) {
      this.$overlay.removeClass("hidden");
      if (message) {
        this.$overlay.find(".spinner").text(message);
      }
    } else {
      this.$overlay.addClass("hidden");
    }
  },
  loadData() {
    const fetches = [
      fetch(OPENINGS_CSV).then((res) => res.text()),
      fetch(LINES_CSV).then((res) => res.text()),
      fetch(MOVES_CSV).then((res) => res.text()),
      fetch(MISTAKE_TEMPLATES_CSV).then((res) => res.text())
    ];

    Promise.all(fetches)
      .then(([openingsText, linesText, movesText, mistakesText]) => {
        this.data.openings = csvToObjects(openingsText);
        this.data.lines = csvToObjects(linesText);
        this.data.moves = csvToObjects(movesText);
        this.data.mistakeTemplates = csvToObjects(mistakesText);
        this.buildIndexes();
        this.initBoard();
        this.populateSelectors();
        this.onModeChange();
        this.showLoading(false);
        this.setStatus("Select an opening to begin.");
      })
      .catch((error) => {
        console.error(error);
        this.setStatus("Failed to load data. Please refresh.");
        this.showLoading(true, "Failed to load CSV data.");
      });
  },
  buildIndexes() {
    this.data.openingsById = {};
    this.data.linesByOpeningId = {};
    this.data.movesByLineId = {};
    this.data.mistakeTemplatesByCode = {};

    this.data.openings.forEach((opening) => {
      this.data.openingsById[opening.opening_id] = opening;
    });

    this.data.lines.forEach((line) => {
      const key = line.opening_id;
      if (!this.data.linesByOpeningId[key]) {
        this.data.linesByOpeningId[key] = [];
      }
      this.data.linesByOpeningId[key].push(line);
    });

    this.data.moves.forEach((move) => {
      const key = move.line_id;
      if (!this.data.movesByLineId[key]) {
        this.data.movesByLineId[key] = [];
      }
      this.data.movesByLineId[key].push(move);
    });

    Object.keys(this.data.movesByLineId).forEach((lineId) => {
      this.data.movesByLineId[lineId].sort((a, b) => {
        const aPly = parseInt(a.ply || "0", 10);
        const bPly = parseInt(b.ply || "0", 10);
        return aPly - bPly;
      });
    });

    this.data.mistakeTemplates.forEach((tmpl) => {
      this.data.mistakeTemplatesByCode[tmpl.mistake_code] = tmpl;
    });
  },
  initBoard() {
    this.chess = new Chess();
    const pieceTheme = (piece) => `pieces/${piece}.png`;
    this.board = Chessboard("board", {
      position: "start",
      draggable: true,
      pieceTheme,
      onDragStart: (source, piece) => this.handleDragStart(source, piece),
      onDrop: (source, target) => this.handleDrop(source, target),
      onSnapEnd: () => this.board.position(this.chess.fen())
    });

    this.sounds.move = new Audio("sounds/move.mp3");
    this.sounds.capture = new Audio("sounds/capture.mp3");
    this.sounds.error = new Audio("sounds/error.mp3");
  },
  populateSelectors() {
    const openings = this.data.openings.filter((o) => isTrue(o.published));
    this.$opening.empty();
    openings.forEach((opening) => {
      this.$opening.append(
        $("<option>").val(opening.opening_id).text(opening.opening_name || opening.opening_id)
      );
    });
    if (openings.length > 0) {
      this.state.openingId = openings[0].opening_id;
      this.$opening.val(this.state.openingId);
      this.populateLines();
    }
  },
  populateLines() {
    const lines = this.data.linesByOpeningId[this.state.openingId] || [];
    this.$line.empty();
    if (this.state.mode === "game") {
      this.$line.append($("<option>").val("any").text("Any line"));
    }
    lines.forEach((line) => {
      const label = line.line_name || line.line_id;
      this.$line.append($("<option>").val(line.line_id).text(label));
    });
    const defaultLine = lines[0];
    this.state.lineId = defaultLine ? defaultLine.line_id : null;
    if (this.state.mode === "game") {
      this.$line.val("any");
    } else if (this.state.lineId) {
      this.$line.val(this.state.lineId);
    }
    this.updateProgress();
    this.updateSideSelector();
  },
  onOpeningChange() {
    this.state.openingId = this.$opening.val();
    this.populateLines();
  },
  onLineChange() {
    this.state.lineId = this.$line.val();
    this.updateProgress();
    this.updateSideSelector();
  },
  onModeChange() {
    this.state.mode = this.$mode.val();
    this.populateLines();
    this.updateSideSelector();
    this.$strengthField.toggle(this.state.mode === "game");
    this.$hint.prop("disabled", this.state.mode !== "practice");
    this.setComment("Choose Start to begin.");
    this.resetSession();
  },
  onSideChange() {
    this.state.userSide = this.$side.val();
    this.board.orientation(this.state.userSide);
    this.resetSession();
  },
  onStrengthChange() {
    if (this.state.mode === "game") {
      this.resetSession();
    }
  },
  updateSideSelector() {
    if (this.state.mode === "learning" || this.state.mode === "practice") {
      const line = this.getSelectedLine();
      const drillSide = (line && line.drill_side || "").toLowerCase();
      if (drillSide === "white" || drillSide === "black") {
        this.$side.val(drillSide);
        this.$side.prop("disabled", true);
        this.state.userSide = drillSide;
      } else {
        this.$side.prop("disabled", false);
        this.state.userSide = this.$side.val();
      }
    } else {
      this.$side.prop("disabled", false);
      this.state.userSide = this.$side.val();
    }
    this.board.orientation(this.state.userSide);
  },
  startSession() {
    this.resetSession(true);
  },
  resetSession(forceStart) {
    this.state.currentPlyIndex = 0;
    this.state.mistakes = 0;
    this.state.hintLevel = 0;
    this.state.completed = false;
    this.state.inBook = false;
    this.state.bookLineMoves = [];
    this.state.bookPlyIndex = 0;
    this.state.bookMaxPlies = 0;
    this.state.engineBusy = false;
    this.$moveList.empty();
    this.$engineEval.text("");

    const opening = this.getSelectedOpening();
    const line = this.getSelectedLine();
    let fen = "start";
    if (this.state.mode === "game") {
      fen = opening && opening.starting_fen ? opening.starting_fen : "start";
    } else if (line && line.start_fen) {
      fen = line.start_fen;
    } else if (opening && opening.starting_fen) {
      fen = opening.starting_fen;
    }

    this.chess.reset();
    if (fen && fen !== "start") {
      this.chess.load(fen);
    }
    this.board.position(this.chess.fen());

    if (this.state.mode === "learning" || this.state.mode === "practice") {
      if (!line && !forceStart) {
        this.setStatus("Select a line to begin.");
        return;
      }
      this.state.currentLineMoves = line ? (this.data.movesByLineId[line.line_id] || []) : [];
      this.setLineStatus(line);
      this.maybeAutoPlay();
      this.showLearningPrompt();
      this.updateProgress();
    } else {
      this.prepareGameMode();
      this.setLineStatus(null);
    }
  },
  prepareGameMode() {
    const opening = this.getSelectedOpening();
    const lineId = this.$line.val();
    const lines = this.data.linesByOpeningId[this.state.openingId] || [];
    let selectedLine = null;
    if (lineId && lineId !== "any") {
      selectedLine = lines.find((line) => line.line_id === lineId) || null;
    } else if (lines.length > 0) {
      selectedLine = pickWeightedLine(lines);
    }

    this.state.bookLineMoves = selectedLine ? (this.data.movesByLineId[selectedLine.line_id] || []) : [];
    this.state.bookPlyIndex = 0;
    const maxPlies = opening && opening.book_max_plies_game_mode ? parseInt(opening.book_max_plies_game_mode, 10) : 0;
    this.state.bookMaxPlies = Number.isFinite(maxPlies) ? maxPlies : 0;
    this.state.inBook = this.state.bookLineMoves.length > 0 && this.state.bookMaxPlies > 0;

    this.ensureEngine();
    this.updateProgress();
    this.setStatus("Game mode: your move.");
    this.setComment("Play through the opening book, then test yourself against Stockfish.");
  },
  handleDragStart(source, piece) {
    if (this.chess.game_over()) {
      return false;
    }
    const turn = this.chess.turn() === "w" ? "white" : "black";
    if (turn !== this.state.userSide) {
      return false;
    }
    if (this.state.mode !== "game" && this.state.mode !== "learning" && this.state.mode !== "practice") {
      return false;
    }
    if (this.state.mode === "learning" || this.state.mode === "practice") {
      const expected = this.getExpectedRow();
      if (!expected) {
        return false;
      }
    }
    if ((turn === "white" && piece.startsWith("b")) || (turn === "black" && piece.startsWith("w"))) {
      return false;
    }
    return true;
  },
  handleDrop(source, target) {
    const promotion = needsPromotion(source, target, this.chess) ? "q" : undefined;
    const uci = `${source}${target}${promotion || ""}`;

    if (this.state.mode === "learning" || this.state.mode === "practice") {
      return this.handleTrainingMove(uci, promotion);
    }

    if (this.state.mode === "game") {
      return this.handleGameMove(uci, promotion);
    }

    return "snapback";
  },
  handleTrainingMove(uci, promotion) {
    const expected = this.getExpectedRow();
    if (!expected) {
      this.setStatus("Line complete.");
      return "snapback";
    }

    const legalMove = this.chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion
    });

    if (!legalMove) {
      this.playSound("error");
      return "snapback";
    }

    const acceptable = getAcceptableMoves(expected);
    if (!acceptable.includes(uci)) {
      this.chess.undo();
      this.handleWrongMove(uci, expected);
      this.playSound("error");
      return "snapback";
    }

    this.playMoveSound(legalMove);
    this.state.currentPlyIndex += 1;
    this.state.hintLevel = 0;
    this.updateMoveList();
    this.setLineStatus(this.getSelectedLine());
    if (this.state.mode === "learning") {
      this.showLearningExplain(expected);
    } else {
      this.showPracticeCorrect(expected);
    }
    this.maybeAutoPlay();
    this.checkLineComplete();
    return;
  },
  handleGameMove(uci, promotion) {
    const legalMove = this.chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion
    });
    if (!legalMove) {
      this.playSound("error");
      return "snapback";
    }

    this.playMoveSound(legalMove);
    this.updateMoveList();

    if (this.state.inBook) {
      const expected = this.state.bookLineMoves[this.state.bookPlyIndex];
      const maxReached = this.state.bookPlyIndex >= this.state.bookMaxPlies;
      if (!expected || maxReached) {
        this.state.inBook = false;
      } else {
        const acceptable = getAcceptableMoves(expected);
        if (acceptable.includes(uci)) {
          this.state.bookPlyIndex += 1;
        } else {
          this.state.inBook = false;
        }
      }
    }

    this.nextGameTurn();
    return;
  },
  nextGameTurn() {
    if (this.chess.game_over()) {
      this.setStatus("Game over.");
      return;
    }
    const turn = this.chess.turn() === "w" ? "white" : "black";
    if (turn !== this.state.userSide) {
      if (this.state.inBook) {
        this.playBookMove();
      } else {
        this.playEngineMove();
      }
    } else {
      this.setStatus("Your move.");
    }
  },
  playBookMove() {
    const expected = this.state.bookLineMoves[this.state.bookPlyIndex];
    if (!expected) {
      this.state.inBook = false;
      this.nextGameTurn();
      return;
    }
    const move = applyMoveUCI(this.chess, expected.move_uci);
    if (!move) {
      this.state.inBook = false;
      this.nextGameTurn();
      return;
    }
    this.playMoveSound(move);
    this.state.bookPlyIndex += 1;
    if (this.state.bookPlyIndex >= this.state.bookMaxPlies) {
      this.state.inBook = false;
    }
    this.updateMoveList();
    this.setStatus("Opponent move played.");
    this.nextGameTurn();
  },
  playEngineMove() {
    if (!this.engine) {
      this.setStatus("Engine unavailable.");
      return;
    }
    if (this.state.engineBusy) {
      return;
    }
    this.state.engineBusy = true;
    const movetime = getEngineMoveTime(this.$strength.val());
    this.engine.getBestMove(this.chess.fen(), movetime, (bestmove) => {
      this.state.engineBusy = false;
      if (!bestmove || bestmove === "(none)") {
        this.setStatus("Engine found no move.");
        return;
      }
      const move = applyMoveUCI(this.chess, bestmove);
      if (!move) {
        this.setStatus("Engine move failed.");
        return;
      }
      this.playMoveSound(move);
      this.updateMoveList();
      this.setStatus("Opponent move played.");
      this.nextGameTurn();
    }, (evalText) => {
      this.$engineEval.text(evalText);
    });
  },
  handleWrongMove(uci, row) {
    this.state.mistakes += 1;
    if (this.state.mode === "learning") {
      const msg = row.practice_bad || "Try again.";
      this.setComment(msg);
      this.setStatus("Not quite. Try again.");
      return;
    }

    const mistakeMessage = this.lookupMistake(uci, row);
    if (mistakeMessage) {
      this.setComment(mistakeMessage);
    } else {
      this.setComment(row.practice_bad || "Not quite. Try again.");
    }
    this.setStatus("Incorrect. Try again.");
  },
  lookupMistake(uci, row) {
    if (!row.mistake_map) {
      return "";
    }
    const mapEntries = row.mistake_map.split("|").map((entry) => entry.trim()).filter(Boolean);
    for (const entry of mapEntries) {
      const [move, code] = entry.split(">");
      if (move && code && move.trim() === uci) {
        const tmpl = this.data.mistakeTemplatesByCode[code.trim()];
        if (!tmpl) {
          return "";
        }
        const coach = tmpl.coach_message ? `<strong>${tmpl.coach_message}</strong>` : "";
        const why = tmpl.why_wrong ? `<div><em>${tmpl.why_wrong}</em></div>` : "";
        const hint = tmpl.hint ? `<div>Hint: ${tmpl.hint}</div>` : "";
        return `${coach}${why}${hint}`;
      }
    }
    return "";
  },
  maybeAutoPlay() {
    const turn = this.chess.turn() === "w" ? "white" : "black";
    if (turn === this.state.userSide) {
      this.setStatus("Your move.");
      return;
    }
    const expected = this.getExpectedRow();
    if (!expected) {
      this.setStatus("Line complete.");
      return;
    }
    const move = applyMoveUCI(this.chess, expected.move_uci);
    if (!move) {
      this.setStatus("Opponent move failed.");
      return;
    }
    this.playMoveSound(move);
    this.state.currentPlyIndex += 1;
    this.updateMoveList();
    this.setLineStatus(this.getSelectedLine());
    this.setStatus("Opponent move played.");
    this.showLearningPrompt();
    this.maybeAutoPlay();
  },
  showLearningPrompt() {
    if (this.state.mode !== "learning") {
      return;
    }
    const expected = this.getExpectedRow();
    if (expected) {
      this.setComment(expected.learn_prompt || "Your move.");
    }
  },
  showLearningExplain(row) {
    this.setComment(row.learn_explain || "Good move. Continue.");
  },
  showPracticeCorrect(row) {
    this.setComment(row.practice_good || "Correct.");
  },
  handleHint() {
    if (this.state.mode !== "practice") {
      return;
    }
    const row = this.getExpectedRow();
    if (!row) {
      return;
    }
    if (this.state.hintLevel === 0 && row.practice_hint) {
      this.setComment(`Hint: ${row.practice_hint}`);
      this.state.hintLevel = 1;
    } else if (this.state.hintLevel === 1 && row.practice_deep_hint) {
      this.setComment(`Deep hint: ${row.practice_deep_hint}`);
      this.state.hintLevel = 2;
    } else if (this.state.mistakes >= 3) {
      const san = row.move_san || row.move_uci;
      this.setComment(`Correct move: <strong>${san}</strong>`);
    } else {
      this.setComment("Keep trying. Make a few attempts to unlock more hints.");
    }
  },
  checkLineComplete() {
    if (this.state.completed) {
      return;
    }
    if (this.state.currentPlyIndex >= this.state.currentLineMoves.length) {
      this.state.completed = true;
      this.setStatus("Line complete.");
      this.setComment("Line complete. Great work!");
      this.setLineStatus(this.getSelectedLine());
      this.updateProgress(true);
    }
  },
  updateProgress(markComplete) {
    const line = this.getSelectedLine();
    if (!line) {
      this.$progress.text("");
      return;
    }
    const key = progressKey(this.state.openingId, line.line_id);
    let data = readProgress(key);
    if (markComplete) {
      data.completed += 1;
      if (this.state.mistakes === 0) {
        data.perfect += 1;
      }
      data.last = new Date().toISOString();
      saveProgress(key, data);
    }
    const lastDate = data.last ? new Date(data.last).toLocaleDateString() : "Never";
    this.$progress.text(`Progress: ${data.completed} completions (${data.perfect} perfect) • Last: ${lastDate}`);
  },
  updateMoveList() {
    const history = this.chess.history({ verbose: true });
    this.$moveList.empty();
    for (let i = 0; i < history.length; i += 2) {
      const whiteMove = history[i];
      const blackMove = history[i + 1];
      const moveText = `${Math.floor(i / 2) + 1}. ${whiteMove ? whiteMove.san : ""} ${blackMove ? blackMove.san : ""}`;
      this.$moveList.append($("<li>").text(moveText.trim()));
    }
  },
  setStatus(text) {
    this.$status.text(text);
  },
  setComment(html) {
    this.$comment.html(html);
  },
  setLineStatus(line) {
    if (!line) {
      this.$lineStatus.text("Game mode active.");
      return;
    }
    const ply = this.state.currentPlyIndex + 1;
    const total = this.state.currentLineMoves.length;
    const lineName = line.line_name || line.line_id;
    this.$lineStatus.text(`Line: ${lineName} • Ply ${Math.min(ply, total)} of ${total}`);
  },
  getSelectedOpening() {
    return this.data.openingsById[this.state.openingId] || null;
  },
  getSelectedLine() {
    if (this.state.mode === "game") {
      const lineId = this.$line.val();
      if (!lineId || lineId === "any") {
        return null;
      }
      return (this.data.linesByOpeningId[this.state.openingId] || []).find((line) => line.line_id === lineId) || null;
    }
    return (this.data.linesByOpeningId[this.state.openingId] || []).find((line) => line.line_id === this.state.lineId) || null;
  },
  getExpectedRow() {
    return this.state.currentLineMoves[this.state.currentPlyIndex] || null;
  },
  playMoveSound(move) {
    if (move.flags.includes("c") || move.flags.includes("e")) {
      this.playSound("capture");
    } else {
      this.playSound("move");
    }
  },
  playSound(key) {
    const sound = this.sounds[key];
    if (sound) {
      sound.currentTime = 0;
      sound.play().catch(() => {});
    }
  },
  ensureEngine() {
    if (this.engine) {
      return;
    }
    this.engine = new StockfishEngine("engine/stockfish-nnue-16-single.js");
  }
};

class StockfishEngine {
  constructor(path) {
    this.worker = null;
    this.ready = false;
    this.pending = [];
    this.listeners = [];
    this.init(path);
  }

  init(path) {
    try {
      this.worker = new Worker(path);
    } catch (error) {
      console.error("Failed to start Stockfish worker", error);
      return;
    }

    this.worker.onmessage = (event) => {
      const text = event.data;
      if (text === "readyok") {
        this.ready = true;
      }
      this.listeners.forEach((listener) => listener(text));
    };

    this.send("uci");
    this.send("isready");
  }

  send(message) {
    if (this.worker) {
      this.worker.postMessage(message);
    }
  }

  getBestMove(fen, movetime, onBestmove, onInfo) {
    const listener = (text) => {
      if (text.startsWith("info") && onInfo) {
        const evalText = parseEval(text, fen);
        if (evalText) {
          onInfo(evalText);
        }
      }
      if (text.startsWith("bestmove")) {
        const bestmove = text.split(" ")[1];
        this.listeners = this.listeners.filter((item) => item !== listener);
        onBestmove(bestmove);
      }
    };
    this.listeners.push(listener);
    this.send(`position fen ${fen}`);
    this.send(`go movetime ${movetime}`);
  }
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(current);
      current = "";
    } else if (char === "\n") {
      row.push(current);
      rows.push(row);
      row = [];
      current = "";
    } else if (char === "\r") {
      continue;
    } else {
      current += char;
    }
  }

  if (current.length || row.length) {
    row.push(current);
    rows.push(row);
  }

  return rows;
}

function csvToObjects(text) {
  const rows = parseCSV(text);
  if (!rows.length) {
    return [];
  }
  const headers = rows.shift().map((header) => header.trim());
  return rows
    .filter((row) => row.some((cell) => cell && cell.trim() !== ""))
    .map((row) => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] !== undefined ? row[index].trim() : "";
      });
      return obj;
    });
}

function isTrue(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function getAcceptableMoves(row) {
  const moves = [row.move_uci];
  if (row.accept_uci) {
    row.accept_uci.split("|").forEach((move) => {
      if (move.trim()) {
        moves.push(move.trim());
      }
    });
  }
  return moves.filter(Boolean);
}

function applyMoveUCI(chess, uci) {
  if (!uci || uci.length < 4) {
    return null;
  }
  const move = {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4)
  };
  if (uci.length > 4) {
    move.promotion = uci[4];
  }
  return chess.move(move);
}

function needsPromotion(from, to, chess) {
  const piece = chess.get(from);
  if (!piece || piece.type !== "p") {
    return false;
  }
  const targetRank = to[1];
  return (piece.color === "w" && targetRank === "8") || (piece.color === "b" && targetRank === "1");
}

function progressKey(openingId, lineId) {
  return `progress_${openingId}_${lineId}`;
}

function readProgress(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return { completed: 0, perfect: 0, last: "" };
    }
    const data = JSON.parse(raw);
    return {
      completed: data.completed || 0,
      perfect: data.perfect || 0,
      last: data.last || ""
    };
  } catch (error) {
    return { completed: 0, perfect: 0, last: "" };
  }
}

function saveProgress(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

function pickWeightedLine(lines) {
  const weights = lines.map((line) => {
    const priority = parseFloat(line.line_priority || "1");
    return Number.isFinite(priority) && priority > 0 ? priority : 1;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < lines.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) {
      return lines[i];
    }
  }
  return lines[0];
}

function getEngineMoveTime(level) {
  switch (level) {
    case "beginner":
      return 150;
    case "intermediate":
      return 300;
    case "strong":
      return 700;
    default:
      return 250;
  }
}

function parseEval(text, fen) {
  if (!text.includes("score")) {
    return "";
  }
  const scoreMatch = text.match(/score (cp|mate) (-?\d+)/);
  if (!scoreMatch) {
    return "";
  }
  const type = scoreMatch[1];
  const value = parseInt(scoreMatch[2], 10);
  if (!Number.isFinite(value)) {
    return "";
  }
  if (type === "mate") {
    return `Engine eval: Mate in ${Math.abs(value)}`;
  }
  const cp = (value / 100).toFixed(2);
  const turn = fen.split(" ")[1];
  const adjusted = turn === "b" ? -value : value;
  const adjustedCp = (adjusted / 100).toFixed(2);
  return `Engine eval: ${adjustedCp}`;
}

$(document).ready(() => {
  App.init();
});
