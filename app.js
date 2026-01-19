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

const OPPONENT_DELAY_MS = 500;

const App = {
  data: {
    openings: [],
    lines: [],
    moves: [],
    mistakeTemplates: [],
    openingsById: {},
    linesByOpeningId: {},
    linesById: {},
    movesByLineId: {},
    movesByOpeningFen: {},
    linePriorityById: {},
    mistakeTemplatesByCode: {}
  },
  state: {
    mode: "learning",
    openingId: null,
    lineId: null,
    userSide: "white",
    currentLineMoves: [],
    currentPlyIndex: 0,
    moveHistory: [],
    redoMoves: [],
    mistakes: 0,
    wrongAttemptsForPly: 0,
    hintLevel: 0,
    revealStage: 0,
    hadLapse: false,
    completed: false,
    inBook: false,
    bookLineMoves: [],
    bookPlyIndex: 0,
    bookMaxPlies: 0,
    engineReady: false,
    engineBusy: false,
    studyDueOnly: false,
    sessionLineId: null,
    selectedSquare: null,
    selectedPiece: null,
    sessionActive: false,
    pendingAutoPlayTimer: null,
    pendingOpponentTimer: null,
    lastHintSquare: null,
    analysisFen: null,
    analysisActive: false,
    statusText: "",
    lastCoachComment: "",
    currentCoachComment: "Welcome to ChessGym.",
    hintActive: false
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
    this.$dueBtn = $("#dueBtn");
    this.$mode = $("#modeSelect");
    this.$side = $("#sideSelect");
    this.$strength = $("#strengthSelect");
    this.$prev = $("#prevBtn");
    this.$next = $("#nextBtn");
    this.$lineStatus = $("#lineStatus");
    this.$progress = $("#progressInfo");
    this.$comment = $("#commentBox");
    this.$hint = $("#hintBtn");
    this.$reveal = $("#revealBtn");
    this.$moveList = $("#moveList");
    this.$engineEval = $("#engineEval");
    this.$overlay = $("#loadingOverlay");
    this.$strengthField = $("#strengthField");
    this.$winProbFill = $("#winProbFill");
    this.$winProbText = $("#winProbText");
  },
  bindEvents() {
    this.$opening.on("change", () => this.onOpeningChange());
    this.$line.on("change", () => this.onLineChange());
    this.$dueBtn.on("click", () => this.onStudyDueToggle());
    this.$mode.on("change", () => this.onModeChange());
    this.$side.on("change", () => this.onSideChange());
    this.$strength.on("change", () => this.onStrengthChange());
    this.$prev.on("click", () => this.stepMove(-1));
    this.$next.on("click", () => this.stepMove(1));
    this.$hint.on("click", () => this.handleHint());
    this.$reveal.on("click", () => this.handleRevealMove());
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
    this.renderCoachComment();
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
    this.data.linesById = {};
    this.data.movesByLineId = {};
    this.data.movesByOpeningFen = {};
    this.data.linePriorityById = {};
    this.data.mistakeTemplatesByCode = {};

    this.data.openings.forEach((opening) => {
      this.data.openingsById[opening.opening_id] = opening;
    });

    this.data.lines.forEach((line) => {
      const key = line.opening_id;
      this.data.linesById[line.line_id] = line;
      if (!this.data.linesByOpeningId[key]) {
        this.data.linesByOpeningId[key] = [];
      }
      this.data.linesByOpeningId[key].push(line);
      const priority = parseFloat(line.line_priority || "1");
      this.data.linePriorityById[line.line_id] = Number.isFinite(priority) && priority > 0 ? priority : 1;
    });

    this.data.moves.forEach((move) => {
      const key = move.line_id;
      if (!this.data.movesByLineId[key]) {
        this.data.movesByLineId[key] = [];
      }
      this.data.movesByLineId[key].push(move);

      if (move.fen_before) {
        const line = this.data.linesById[move.line_id];
        if (line && line.opening_id) {
          const openingId = line.opening_id;
          if (!this.data.movesByOpeningFen[openingId]) {
            this.data.movesByOpeningFen[openingId] = {};
          }
          const normalizedFen = normalizeFen(move.fen_before);
          if (normalizedFen) {
            if (!this.data.movesByOpeningFen[openingId][normalizedFen]) {
              this.data.movesByOpeningFen[openingId][normalizedFen] = [];
            }
            this.data.movesByOpeningFen[openingId][normalizedFen].push(move);
          }
        }
      }
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
    const pieceNameByCode = {
      wK: "white-king",
      wQ: "white-queen",
      wR: "white-rook",
      wB: "white-bishop",
      wN: "white-knight",
      wP: "white-pawn",
      bK: "black-king",
      bQ: "black-queen",
      bR: "black-rook",
      bB: "black-bishop",
      bN: "black-knight",
      bP: "black-pawn"
    };
    const pieceTheme = (piece) => `pieces/${pieceNameByCode[piece]}.png`;
    this.board = Chessboard("board", {
      position: "start",
      draggable: false,
      pieceTheme
    });

    this.sounds.move = new Audio("sounds/move.mp3");
    this.sounds.capture = new Audio("sounds/capture.mp3");
    this.sounds.error = new Audio("sounds/error.mp3");

    let lastTouchTime = 0;
    const handleBoardSelect = (event) => {
      if (event.type === "touchend") {
        lastTouchTime = Date.now();
      } else if (event.type === "click" && Date.now() - lastTouchTime < 500) {
        return;
      }
      const squareElement = $(event.currentTarget);
      if (!squareElement.length) {
        return;
      }
      this.handleSquareClick(squareElement);
    };

    $("#board").on("click", ".square-55d63", handleBoardSelect);
    $("#board").on("touchend", ".square-55d63", handleBoardSelect);
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
    const filteredLines = this.getFilteredLines(lines);
    const displayLines = filteredLines.length ? filteredLines : lines;
    const currentSelection = this.$line.val();

    this.$line.empty();
    this.$line.append($("<option>").val("any").text("Any line (weighted)"));
    displayLines.forEach((line) => {
      const label = line.line_name || line.line_id;
      this.$line.append($("<option>").val(line.line_id).text(label));
    });
    let nextSelection = "any";
    if (currentSelection && currentSelection !== "any" && displayLines.some((line) => line.line_id === currentSelection)) {
      nextSelection = currentSelection;
    } else if (currentSelection === "any") {
      nextSelection = "any";
    }
    this.$line.val(nextSelection);
    this.state.lineId = nextSelection;
    this.updateProgress();
    this.updateSideSelector();
  },
  onOpeningChange() {
    this.state.openingId = this.$opening.val();
    this.populateLines();
    this.prepareSession();
  },
  onLineChange() {
    this.state.lineId = this.$line.val();
    this.updateProgress();
    this.updateSideSelector();
    this.prepareSession();
  },
  onStudyDueToggle() {
    this.state.studyDueOnly = !this.state.studyDueOnly;
    const label = this.state.studyDueOnly ? "Study All Lines" : "Study Due Lines";
    this.$dueBtn.text(label);
    this.populateLines();
    this.prepareSession();
  },
  onModeChange() {
    this.state.mode = this.$mode.val();
    this.populateLines();
    this.updateSideSelector();
    this.$strengthField.toggle(this.state.mode === "game");
    this.$hint.prop("disabled", this.state.mode === "game");
    this.$reveal.prop("disabled", this.state.mode !== "practice");
    this.$dueBtn.toggle(this.state.mode === "practice");
    this.$dueBtn.text(this.state.studyDueOnly ? "Study All Lines" : "Study Due Lines");
    this.setComment("Session ready.");
    this.prepareSession();
  },
  onSideChange() {
    this.state.userSide = this.$side.val();
    this.board.orientation(this.state.userSide);
    this.prepareSession();
  },
  onStrengthChange() {
    if (this.state.mode === "game") {
      this.prepareSession();
    }
  },
  updateSideSelector() {
    if (this.state.mode === "learning" || this.state.mode === "practice") {
      const line = this.getActiveLine();
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
    this.resetSession(true, { autoPlay: true, setActive: true });
  },
  prepareSession() {
    this.resetSession(true, { autoPlay: true, setActive: true });
  },
  resetSession(forceStart, options = {}) {
    const { autoPlay = true, setActive = true } = options;
    this.stopPendingActions();
    this.state.sessionActive = setActive;
    this.state.currentPlyIndex = 0;
    this.state.mistakes = 0;
    this.state.wrongAttemptsForPly = 0;
    this.state.hintLevel = 0;
    this.state.revealStage = 0;
    this.state.hadLapse = false;
    this.state.completed = false;
    this.state.inBook = false;
    this.state.hintActive = false;
    this.state.bookLineMoves = [];
    this.state.bookPlyIndex = 0;
    this.state.bookMaxPlies = 0;
    this.state.engineBusy = false;
    this.state.sessionLineId = null;
    this.state.moveHistory = [];
    this.state.redoMoves = [];
    this.$moveList.empty();
    this.$engineEval.text("");
    this.clearSelection();
    this.clearHintHighlight();
    this.clearLastMoveHighlight();
    this.updateNavigationControls();
    this.updateWinProbability(0.5);

    const opening = this.getSelectedOpening();
    const line = this.resolveSessionLine(forceStart);
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
    this.startLiveAnalysis();

    if (this.state.mode === "learning" || this.state.mode === "practice") {
      if (!line && !forceStart) {
        this.setStatus("Select a line to begin.");
        return;
      }
      this.state.currentLineMoves = line ? (this.data.movesByLineId[line.line_id] || []) : [];
      this.setLineStatus(line);
      if (autoPlay) {
        this.maybeAutoPlay();
        this.showLearningPrompt();
      } else {
        this.setStatus("Session ready.");
        this.setComment("Ready when you are.");
      }
      this.updateProgress();
    } else {
      if (autoPlay) {
        this.prepareGameMode(line);
      } else {
        this.setLineStatus(line);
        this.setStatus("Session ready.");
        this.setComment("Ready to begin game mode.");
      }
    }
  },
  stopPendingActions() {
    if (this.state.pendingAutoPlayTimer) {
      clearTimeout(this.state.pendingAutoPlayTimer);
      this.state.pendingAutoPlayTimer = null;
    }
    if (this.state.pendingOpponentTimer) {
      clearTimeout(this.state.pendingOpponentTimer);
      this.state.pendingOpponentTimer = null;
    }
  },
  prepareGameMode(selectedLine) {
    const opening = this.getSelectedOpening();
    this.state.bookLineMoves = selectedLine ? (this.data.movesByLineId[selectedLine.line_id] || []) : [];
    this.state.bookPlyIndex = 0;
    const maxPlies = opening && opening.book_max_plies_game_mode ? parseInt(opening.book_max_plies_game_mode, 10) : 0;
    this.state.bookMaxPlies = Number.isFinite(maxPlies) ? maxPlies : 0;
    this.state.inBook = this.state.bookLineMoves.length > 0 && this.state.bookMaxPlies > 0;

    this.ensureEngine();
    this.updateProgress();
    this.setStatus("Game mode: your move.");
    this.setComment("Play through the opening book, then test yourself against Stockfish.");
    this.setLineStatus(selectedLine);
  },
  handleSquareClick(squareElement) {
    const square = squareElement.data("square");
    if (!square) {
      return;
    }
    if (this.chess.game_over()) {
      return;
    }
    if (!this.state.sessionActive) {
      this.setStatus("Session ready.");
      return;
    }
    if (!this.state.selectedSquare) {
      const piece = this.chess.get(square);
      if (!piece) {
        return;
      }
      const pieceCode = `${piece.color}${piece.type.toUpperCase()}`;
      const turn = this.chess.turn() === "w" ? "white" : "black";
      if (turn !== this.state.userSide) {
        return;
      }
      if (this.state.mode !== "game" && this.state.mode !== "learning" && this.state.mode !== "practice") {
        return;
      }
      if (this.state.mode === "learning" || this.state.mode === "practice") {
        const expected = this.getExpectedRow();
        if (!expected) {
          return;
        }
      }
      if ((turn === "white" && pieceCode.startsWith("b")) || (turn === "black" && pieceCode.startsWith("w"))) {
        return;
      }
      this.setSelection(square, pieceCode);
      return;
    }
    if (square === this.state.selectedSquare) {
      this.clearSelection();
      return;
    }
    const source = this.state.selectedSquare;
    const target = square;
    const promotion = needsPromotion(source, target, this.chess) ? "q" : undefined;
    const uci = `${source}${target}${promotion || ""}`;

    if (this.state.mode === "learning" || this.state.mode === "practice") {
      this.handleTrainingMove(uci, promotion);
    } else if (this.state.mode === "game") {
      this.handleGameMove(uci, promotion);
    }
    this.clearSelection();
    this.board.position(this.chess.fen());
    this.startLiveAnalysis();
  },
  setSelection(square, pieceCode) {
    this.state.selectedSquare = square;
    this.state.selectedPiece = pieceCode;
    $("#board .square-55d63").removeClass("square-selected");
    $(`#board .square-55d63[data-square='${square}']`).addClass("square-selected");
  },
  clearSelection() {
    this.state.selectedSquare = null;
    this.state.selectedPiece = null;
    $("#board .square-55d63").removeClass("square-selected");
  },
  setHintHighlight(square) {
    this.clearHintHighlight();
    if (!square) {
      return;
    }
    this.state.lastHintSquare = square;
    $(`#board .square-55d63[data-square='${square}']`).addClass("hint-piece");
  },
  clearHintHighlight() {
    if (this.state.lastHintSquare) {
      $(`#board .square-55d63[data-square='${this.state.lastHintSquare}']`).removeClass("hint-piece");
    }
    this.state.lastHintSquare = null;
  },
  clearLastMoveHighlight() {
    $("#board .square-55d63").removeClass("last-move");
  },
  updateLastMoveHighlight() {
    this.clearLastMoveHighlight();
    const history = this.chess.history({ verbose: true });
    const lastMove = history[history.length - 1];
    if (!lastMove) {
      return;
    }
    [lastMove.from, lastMove.to].forEach((square) => {
      $(`#board .square-55d63[data-square='${square}']`).addClass("last-move");
    });
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
    this.recordMove(uci, legalMove);
    this.state.currentPlyIndex += 1;
    this.state.hintLevel = 0;
    this.state.wrongAttemptsForPly = 0;
    this.state.revealStage = 0;
    this.updateMoveList();
    this.updateLastMoveHighlight();
    this.setLineStatus(this.getActiveLine());
    if (this.state.mode === "learning") {
      this.showLearningExplain(expected);
    } else {
      this.showPracticeCorrect(expected);
    }
    if (this.state.currentPlyIndex >= this.state.currentLineMoves.length) {
      this.checkLineComplete();
      return;
    }
    const turn = this.chess.turn() === "w" ? "white" : "black";
    if (turn !== this.state.userSide) {
      this.setStatus("Opponent thinking...");
      this.scheduleAutoPlay();
    } else {
      this.setStatus("Your move.");
    }
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
    this.recordMove(uci, legalMove);
    this.updateMoveList();
    this.updateLastMoveHighlight();

    if (this.state.inBook) {
      const expected = this.getBookExpectedRow();
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

    const turn = this.chess.turn() === "w" ? "white" : "black";
    if (turn !== this.state.userSide) {
      this.setStatus("Opponent thinking...");
      this.scheduleOpponentMove(() => this.nextGameTurn());
    } else {
      this.nextGameTurn();
    }
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
    const expected = this.getBookExpectedRow();
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
    this.recordMove(expected.move_uci, move);
    this.state.bookPlyIndex += 1;
    this.board.position(this.chess.fen());
    this.startLiveAnalysis();
    if (this.state.bookPlyIndex >= this.state.bookMaxPlies) {
      this.state.inBook = false;
    }
    this.updateMoveList();
    this.updateLastMoveHighlight();
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
    this.stopLiveAnalysis();
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
      this.recordMove(bestmove, move);
      this.board.position(this.chess.fen());
      this.startLiveAnalysis();
      this.updateMoveList();
      this.updateLastMoveHighlight();
      this.setStatus("Opponent move played.");
      this.nextGameTurn();
    }, (evalText, evalData) => {
      this.$engineEval.text(evalText);
      if (evalData) {
        this.updateWinProbabilityFromEval(evalData);
      }
    });
  },
  handleWrongMove(uci, row) {
    this.state.mistakes += 1;
    this.state.wrongAttemptsForPly += 1;
    if (this.state.wrongAttemptsForPly >= 3) {
      this.state.hadLapse = true;
    }
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
      this.checkLineComplete();
      return;
    }
    const move = applyMoveUCI(this.chess, expected.move_uci);
    if (!move) {
      this.setStatus("Opponent move failed.");
      return;
    }
    this.playMoveSound(move);
    this.recordMove(expected.move_uci, move);
    this.state.currentPlyIndex += 1;
    this.state.wrongAttemptsForPly = 0;
    this.state.revealStage = 0;
    this.board.position(this.chess.fen());
    this.startLiveAnalysis();
    this.updateMoveList();
    this.updateLastMoveHighlight();
    this.setLineStatus(this.getActiveLine());
    this.setStatus("Opponent move played.");
    this.showLearningPrompt();
    this.maybeAutoPlay();
  },
  scheduleAutoPlay() {
    this.stopPendingActions();
    this.state.pendingAutoPlayTimer = setTimeout(() => {
      this.state.pendingAutoPlayTimer = null;
      this.maybeAutoPlay();
      this.checkLineComplete();
    }, OPPONENT_DELAY_MS);
  },
  scheduleOpponentMove(callback) {
    this.stopPendingActions();
    this.state.pendingOpponentTimer = setTimeout(() => {
      this.state.pendingOpponentTimer = null;
      callback();
    }, OPPONENT_DELAY_MS);
  },
  recordMove(uci, move) {
    if (!move) {
      return;
    }
    const moveUci = uci || moveToUci(move);
    if (!moveUci) {
      return;
    }
    this.state.moveHistory.push(moveUci);
    this.state.redoMoves = [];
    this.clearHintHighlight();
  },
  stepMove(direction) {
    if (direction < 0) {
      const lastMove = this.state.moveHistory.pop();
      if (!lastMove) {
        return;
      }
      const undone = this.chess.undo();
      if (!undone) {
        this.state.moveHistory.push(lastMove);
        return;
      }
      this.state.redoMoves.push(lastMove);
      if (this.state.mode !== "game") {
        this.state.currentPlyIndex = Math.max(0, this.state.currentPlyIndex - 1);
        this.state.completed = false;
      } else {
        this.state.inBook = false;
        this.state.bookPlyIndex = Math.max(0, this.state.bookPlyIndex - 1);
      }
    } else {
      const redoMove = this.state.redoMoves.pop();
      if (!redoMove) {
        return;
      }
      const move = applyMoveUCI(this.chess, redoMove);
      if (!move) {
        return;
      }
      this.state.moveHistory.push(redoMove);
      if (this.state.mode !== "game") {
        this.state.currentPlyIndex = Math.min(this.state.currentLineMoves.length, this.state.currentPlyIndex + 1);
      } else {
        this.state.inBook = false;
      }
    }
    this.board.position(this.chess.fen());
    this.startLiveAnalysis();
    this.updateMoveList();
    this.updateLastMoveHighlight();
    this.clearHintHighlight();
    if (this.state.mode === "learning" || this.state.mode === "practice") {
      this.setLineStatus(this.getActiveLine());
    }
    this.setStatus("Reviewing moves.");
  },
  showLearningPrompt() {
    if (this.state.mode !== "learning") {
      return;
    }
    const expected = this.getExpectedRow();
    if (expected) {
      this.setComment(expected.learn_prompt || "Find the next move.");
    }
  },
  showLearningExplain(row) {
    this.setComment(row.learn_explain || "Good move. Continue.");
  },
  showPracticeCorrect(row) {
    this.setComment(row.practice_good || "Correct.");
  },
  handleHint() {
    const row = this.getExpectedRow();
    if (!row) {
      return;
    }
    if (this.state.hintActive) {
      this.clearHintHighlight();
      this.setComment(this.state.lastCoachComment || "Keep going.");
      this.state.hintActive = false;
      return;
    }
    if (this.state.mode === "learning") {
      const targetSquare = row.move_uci ? row.move_uci.slice(0, 2) : "";
      this.setHintHighlight(targetSquare);
      this.setComment("Hint: the next piece to move is highlighted.", { isHint: true });
      this.state.hintActive = true;
      return;
    }
    if (this.state.mode !== "practice") {
      return;
    }
    if (this.state.hintLevel === 0 && row.practice_hint) {
      this.setComment(`Hint: ${row.practice_hint}`, { isHint: true });
      this.state.hintLevel = 1;
    } else if (this.state.hintLevel === 1 && row.practice_deep_hint) {
      this.setComment(`Deep hint: ${row.practice_deep_hint}`, { isHint: true });
      this.state.hintLevel = 2;
    } else {
      this.setComment("Keep trying. Make a few attempts to unlock more hints.", { isHint: true });
    }
    this.state.hintActive = true;
  },
  handleRevealMove() {
    if (this.state.mode !== "practice") {
      return;
    }
    const row = this.getExpectedRow();
    if (!row) {
      return;
    }
    if (this.state.revealStage === 0 && this.state.hintLevel < 2 && row.practice_deep_hint) {
      this.setComment(`Deep hint: ${row.practice_deep_hint}`);
      this.state.hintLevel = 2;
      this.state.revealStage = 1;
      return;
    }
    const san = row.move_san || row.move_uci;
    this.setComment(`Correct move: <strong>${san}</strong>`);
    this.state.revealStage = 2;
    this.state.hadLapse = true;
  },
  checkLineComplete() {
    if (this.state.completed) {
      return;
    }
    if (this.state.currentPlyIndex >= this.state.currentLineMoves.length) {
      this.state.completed = true;
      this.setStatus("Line complete.");
      this.setComment("Line complete. Great work!");
      this.setLineStatus(this.getActiveLine());
      if (this.state.mode === "practice") {
        this.finalizePracticeSR();
      } else if (this.state.mode === "learning") {
        this.recordLearningStudy();
      }
      this.updateProgress();
    }
  },
  updateProgress() {
    const line = this.getActiveLine();
    if (!line) {
      this.$progress.text("");
      return;
    }
    const key = getLineKey(this.state.openingId, line.line_id);
    const srData = loadSR();
    const sr = ensureSRDefaults(srData[key]);
    const reps = sr.reps || 0;
    const ease = sr.ease ? sr.ease.toFixed(2) : "2.50";
    const stats = sr.stats || { completed: 0, perfect: 0, learned: 0 };
    this.$progress.text(
      `Completed: ${stats.completed || 0} • Studied: ${stats.learned || 0} • Perfect: ${stats.perfect || 0} • Reps: ${reps} • Ease: ${ease}`
    );
  },
  finalizePracticeSR() {
    const line = this.getActiveLine();
    if (!line) {
      return;
    }
    const quality = this.getPracticeQuality();
    const lineKey = getLineKey(this.state.openingId, line.line_id);
    updateSR(lineKey, quality, {
      mistakes: this.state.mistakes,
      hadLapse: this.state.hadLapse
    });
  },
  recordLearningStudy() {
    const line = this.getActiveLine();
    if (!line) {
      return;
    }
    const lineKey = getLineKey(this.state.openingId, line.line_id);
    const data = loadSR();
    const sr = ensureSRDefaults(data[lineKey]);
    sr.stats.learned += 1;
    sr.stats.totalAttempts += 1;
    sr.lastPracticedISO = toLocalISO(getTodayLocal());
    data[lineKey] = sr;
    saveSR(data);
  },
  getPracticeQuality() {
    if (this.state.hadLapse) {
      return 1;
    }
    if (this.state.mistakes === 0) {
      return 5;
    }
    return 3;
  },
  getFilteredLines(lines) {
    if (this.state.mode !== "practice" || !this.state.studyDueOnly) {
      return lines;
    }
    const dueLines = this.getDueLines(lines);
    return dueLines.length ? dueLines : lines;
  },
  getDueLines(lines) {
    const srData = loadSR();
    const today = getTodayLocal();
    return lines.filter((line) => {
      const key = getLineKey(this.state.openingId, line.line_id);
      const sr = ensureSRDefaults(srData[key]);
      return isDue(sr, today);
    });
  },
  getLineSelectionWeight(line) {
    const basePriority = this.data.linePriorityById[line.line_id] || 1;
    const srData = loadSR();
    const sr = ensureSRDefaults(srData[getLineKey(this.state.openingId, line.line_id)]);
    const completed = sr.stats.completed || 0;
    const learned = sr.stats.learned || 0;
    const studyCount = completed + learned;
    return basePriority / (1 + studyCount);
  },
  resolveSessionLine(forceStart) {
    const lines = this.data.linesByOpeningId[this.state.openingId] || [];
    const selection = this.$line.val();
    let line = null;
    if (selection && selection !== "any") {
      line = lines.find((item) => item.line_id === selection) || null;
    } else if (forceStart && lines.length) {
      const pool = this.getFilteredLines(lines);
      line = weightedPick(pool, (item) => this.getLineSelectionWeight(item));
    }
    this.state.sessionLineId = line ? line.line_id : null;
    return line;
  },
  getActiveLine() {
    if (this.state.sessionLineId) {
      return this.data.linesById[this.state.sessionLineId] || null;
    }
    const selection = this.$line.val();
    if (!selection || selection === "any") {
      return null;
    }
    return this.data.linesById[selection] || null;
  },
  updateMoveList() {
    const history = this.chess.history({ verbose: true });
    this.$moveList.empty();
    for (let i = 0; i < history.length; i += 2) {
      const whiteMove = history[i];
      const blackMove = history[i + 1];
      const moveText = `${whiteMove ? whiteMove.san : ""} ${blackMove ? blackMove.san : ""}`;
      this.$moveList.append($("<li>").text(moveText.trim()));
    }
    this.updateNavigationControls();
  },
  updateNavigationControls() {
    const hasHistory = this.state.moveHistory.length > 0;
    const hasRedo = this.state.redoMoves.length > 0;
    this.$prev.prop("disabled", !hasHistory);
    this.$next.prop("disabled", !hasRedo);
  },
  updateWinProbabilityFromEval(evalData) {
    const probability = evalToWinProbability(evalData, this.state.userSide);
    this.updateWinProbability(probability);
  },
  updateWinProbability(probability) {
    const clamped = Math.max(0, Math.min(1, probability));
    const percent = Math.round(clamped * 100);
    this.$winProbFill.css("width", `${percent}%`);
    this.$winProbText.text(`${percent}%`);
  },
  setStatus(text) {
    this.state.statusText = text;
    this.renderCoachComment();
  },
  setComment(html, options = {}) {
    this.state.currentCoachComment = html;
    if (!options.isHint) {
      this.state.lastCoachComment = html;
      this.state.hintActive = false;
    }
    this.renderCoachComment();
  },
  renderCoachComment() {
    const base = this.state.currentCoachComment || "";
    const plainBase = base.replace(/<[^>]*>/g, "").trim();
    const needsPrefix = this.state.statusText === "Your move." && !/^your move\b/i.test(plainBase);
    const prefix = needsPrefix ? "<strong>Your move:</strong> " : "";
    this.$comment.html(`${prefix}${base}`);
  },
  setLineStatus(line) {
    if (!line) {
      this.$lineStatus.text(this.state.mode === "game" ? "Game mode active." : "Select a line to begin.");
      return;
    }
    const ply = this.state.currentPlyIndex + 1;
    const total = this.state.currentLineMoves.length;
    const lineName = line.line_name || line.line_id;
    const prefix = this.state.sessionLineId ? "Chosen line" : "Line";
    this.$lineStatus.text(`${prefix}: ${lineName} • Ply ${Math.min(ply, total)} of ${total}`);
  },
  getSelectedOpening() {
    return this.data.openingsById[this.state.openingId] || null;
  },
  getSelectedLine() {
    return this.getActiveLine();
  },
  getExpectedRow() {
    const opening = this.getSelectedOpening();
    if (opening && isTrue(opening.allow_transpositions) && (this.state.mode === "practice" || this.state.mode === "game")) {
      const normalized = normalizeFen(this.chess.fen());
      const matches = (this.data.movesByOpeningFen[this.state.openingId] || {})[normalized] || [];
      if (matches.length) {
        const sessionLineId = this.state.sessionLineId;
        const sorted = [...matches].sort((a, b) => {
          const aSession = sessionLineId && a.line_id === sessionLineId;
          const bSession = sessionLineId && b.line_id === sessionLineId;
          if (aSession !== bSession) {
            return aSession ? -1 : 1;
          }
          const aPriority = this.data.linePriorityById[a.line_id] || 1;
          const bPriority = this.data.linePriorityById[b.line_id] || 1;
          if (aPriority !== bPriority) {
            return bPriority - aPriority;
          }
          const aPly = parseInt(a.ply || "0", 10);
          const bPly = parseInt(b.ply || "0", 10);
          return aPly - bPly;
        });
        return sorted[0];
      }
    }
    return this.state.currentLineMoves[this.state.currentPlyIndex] || null;
  },
  getBookExpectedRow() {
    const opening = this.getSelectedOpening();
    if (opening && isTrue(opening.allow_transpositions)) {
      const expected = this.getExpectedRow();
      if (expected) {
        return expected;
      }
    }
    return this.state.bookLineMoves[this.state.bookPlyIndex] || null;
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
  startLiveAnalysis() {
    this.ensureEngine();
    if (!this.engine) {
      return;
    }
    const fen = this.chess.fen();
    if (this.state.analysisActive && this.state.analysisFen === fen) {
      return;
    }
    this.state.analysisFen = fen;
    this.state.analysisActive = true;
    this.engine.startAnalysis(fen, (evalText, evalData) => {
      this.$engineEval.text(evalText);
      if (evalData) {
        this.updateWinProbabilityFromEval(evalData);
      }
    });
  },
  stopLiveAnalysis() {
    if (this.engine) {
      this.engine.stopAnalysis();
    }
    this.state.analysisActive = false;
    this.state.analysisFen = null;
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
    this.analysisListener = null;
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

  startAnalysis(fen, onInfo) {
    this.stopAnalysis();
    const listener = (text) => {
      if (text.startsWith("info") && onInfo) {
        const evalText = parseEval(text, fen);
        if (evalText) {
          const evalData = parseEvalData(text, fen);
          onInfo(evalText, evalData);
        }
      }
    };
    this.analysisListener = listener;
    this.listeners.push(listener);
    this.send(`position fen ${fen}`);
    this.send("go infinite");
  }

  stopAnalysis() {
    if (this.analysisListener) {
      this.listeners = this.listeners.filter((item) => item !== this.analysisListener);
      this.analysisListener = null;
    }
    this.send("stop");
  }

  getBestMove(fen, movetime, onBestmove, onInfo) {
    this.stopAnalysis();
    const listener = (text) => {
      if (text.startsWith("info") && onInfo) {
        const evalText = parseEval(text, fen);
        if (evalText) {
          const evalData = parseEvalData(text, fen);
          onInfo(evalText, evalData);
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

function moveToUci(move) {
  if (!move || !move.from || !move.to) {
    return "";
  }
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function needsPromotion(from, to, chess) {
  const piece = chess.get(from);
  if (!piece || piece.type !== "p") {
    return false;
  }
  const targetRank = to[1];
  return (piece.color === "w" && targetRank === "8") || (piece.color === "b" && targetRank === "1");
}

const SR_STORAGE_KEY = "sr_data_v1";
let srMemoryStore = {};

function getLineKey(openingId, lineId) {
  return `sr_${openingId}_${lineId}`;
}

function loadSR() {
  try {
    const raw = localStorage.getItem(SR_STORAGE_KEY);
    if (!raw) {
      return srMemoryStore;
    }
    return JSON.parse(raw) || srMemoryStore;
  } catch (error) {
    return srMemoryStore;
  }
}

function saveSR(data) {
  srMemoryStore = data;
  try {
    localStorage.setItem(SR_STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    // Fallback to in-memory storage when localStorage is unavailable.
  }
}

function ensureSRDefaults(sr) {
  if (!sr) {
    return {
      lastPracticedISO: "",
      dueISO: "",
      intervalDays: 0,
      ease: 2.5,
      reps: 0,
      lapses: 0,
      stats: {
        completed: 0,
        learned: 0,
        perfect: 0,
        totalMistakes: 0,
        totalAttempts: 0
      }
    };
  }
  return {
    lastPracticedISO: sr.lastPracticedISO || "",
    dueISO: sr.dueISO || "",
    intervalDays: Number.isFinite(sr.intervalDays) ? sr.intervalDays : 0,
    ease: Number.isFinite(sr.ease) ? sr.ease : 2.5,
    reps: Number.isFinite(sr.reps) ? sr.reps : 0,
    lapses: Number.isFinite(sr.lapses) ? sr.lapses : 0,
    stats: {
      completed: sr.stats && Number.isFinite(sr.stats.completed) ? sr.stats.completed : 0,
      learned: sr.stats && Number.isFinite(sr.stats.learned) ? sr.stats.learned : 0,
      perfect: sr.stats && Number.isFinite(sr.stats.perfect) ? sr.stats.perfect : 0,
      totalMistakes: sr.stats && Number.isFinite(sr.stats.totalMistakes) ? sr.stats.totalMistakes : 0,
      totalAttempts: sr.stats && Number.isFinite(sr.stats.totalAttempts) ? sr.stats.totalAttempts : 0
    }
  };
}

function updateSR(lineKey, quality, details) {
  const data = loadSR();
  const sr = ensureSRDefaults(data[lineKey]);
  const today = getTodayLocal();
  const mistakes = details && Number.isFinite(details.mistakes) ? details.mistakes : 0;

  sr.lastPracticedISO = toLocalISO(today);
  sr.stats.completed += 1;
  sr.stats.totalAttempts += 1;
  sr.stats.totalMistakes += mistakes;

  if (quality < 3) {
    sr.intervalDays = 1;
    sr.lapses += 1;
  } else {
    sr.reps += 1;
    if (sr.reps === 1) {
      sr.intervalDays = 1;
    } else if (sr.reps === 2) {
      sr.intervalDays = 3;
    } else {
      sr.intervalDays = Math.round(sr.intervalDays * sr.ease);
    }
  }

  if (quality === 5) {
    sr.stats.perfect += 1;
  }

  const easeDelta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  sr.ease = Math.max(1.3, sr.ease + easeDelta);

  const dueDate = addDays(today, sr.intervalDays || 0);
  sr.dueISO = toLocalISO(dueDate);

  data[lineKey] = sr;
  saveSR(data);
}

function weightedPick(lines, weightFn) {
  if (!lines.length) {
    return null;
  }
  const weights = lines.map((line) => {
    const weight = weightFn ? weightFn(line) : 1;
    return Number.isFinite(weight) && weight > 0 ? weight : 1;
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

function isDue(sr, today) {
  if (!sr || !sr.dueISO) {
    return true;
  }
  const dueDate = startOfDay(new Date(sr.dueISO));
  return dueDate.getTime() <= today.getTime();
}

function normalizeFen(fen) {
  if (!fen) {
    return "";
  }
  const parts = fen.trim().split(" ");
  if (parts.length < 4) {
    return fen.trim();
  }
  return parts.slice(0, 4).join(" ");
}

function getTodayLocal() {
  return startOfDay(new Date());
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + days);
  return result;
}

function toLocalISO(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
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

function parseEvalData(text, fen) {
  if (!text.includes("score")) {
    return null;
  }
  const scoreMatch = text.match(/score (cp|mate) (-?\d+)/);
  if (!scoreMatch) {
    return null;
  }
  const type = scoreMatch[1];
  const rawValue = parseInt(scoreMatch[2], 10);
  if (!Number.isFinite(rawValue)) {
    return null;
  }
  const turn = fen.split(" ")[1];
  const adjusted = turn === "b" ? -rawValue : rawValue;
  if (type === "mate") {
    return { type, value: adjusted };
  }
  return { type, value: adjusted / 100 };
}

function evalToWinProbability(evalData, userSide) {
  if (!evalData) {
    return 0.5;
  }
  let score = evalData.value;
  if (userSide === "black") {
    score = -score;
  }
  if (evalData.type === "mate") {
    return score > 0 ? 0.99 : 0.01;
  }
  const winProb = 1 / (1 + Math.exp(-0.8 * score));
  return Math.max(0.01, Math.min(0.99, winProb));
}

$(document).ready(() => {
  App.init();
});
