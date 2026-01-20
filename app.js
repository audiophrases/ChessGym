/*
  ChessGym uses four CSV feeds:
  - openings: core opening metadata (opening_id, starting_fen, book_max_plies_game_mode, etc.).
  - lines: named training lines (opening_id, line_id, drill_side, start_fen, moves_pgn).
  - nodes: streamlined per-node instructions (opening_id, line_id, node_id, parent_node_id, move_uci, learn_prompt, mistake_map).
  - mistake_templates: global messaging for mapped mistakes (mistake_code -> coach_message, why_wrong, hint).
*/

const OPENINGS_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=0&single=true&output=csv";
const LINES_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=10969022&single=true&output=csv";
const NODES_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=1261107814&single=true&output=csv";
const MISTAKE_TEMPLATES_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=1251282566&single=true&output=csv";

const OPPONENT_DELAY_MS = 500;

const App = {
  data: {
    openings: [],
    lines: [],
    nodes: [],
    mistakeTemplates: [],
    openingsById: {},
    linesByOpeningId: {},
    linesById: {},
    nodesByLineId: {},
    nodesById: {},
    childrenByParentKey: {},
    rootNodesByLineId: {},
    nodesByOpeningFen: {},
    linePriorityById: {},
    mistakeTemplatesByCode: {}
  },
  state: {
    mode: "learning",
    openingId: null,
    lineId: null,
    userSide: "white",
    sessionPlan: null,
    currentDepth: -1,
    moveHistory: [],
    redoMoves: [],
    mistakes: 0,
    wrongAttemptsForPly: 0,
    hintLevel: 0,
    revealStage: 0,
    hadLapse: false,
    completed: false,
    inBook: false,
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
    previousCoachComment: "",
    currentCoachComment: "Welcome to ChessGym.",
    hintActive: false,
    boardSizeIndex: 2
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
    this.$strength = $("#strengthSelect");
    this.$prev = $("#prevBtn");
    this.$next = $("#nextBtn");
    this.$sessionSummary = $("#sessionSummary");
    this.$sessionSelectors = $("#sessionSelectors");
    this.$lineStatus = $("#lineStatus");
    this.$progress = $("#progressInfo");
    this.$progressText = $("#progressText");
    this.$comment = $("#commentBox");
    this.$hint = $("#hintBtn");
    this.$reveal = $("#revealBtn");
    this.$lichess = $("#lichessBtn");
    this.$engineEval = $("#engineEval");
    this.$overlay = $("#loadingOverlay");
    this.$strengthField = $("#strengthField");
    this.$winProbText = $("#winProbText");
    this.$board = $("#board");
    this.$boardZoomIn = $("#boardZoomIn");
    this.$boardZoomOut = $("#boardZoomOut");
  },
  bindEvents() {
    this.$opening.on("change", () => this.onOpeningChange());
    this.$line.on("change", () => this.onLineChange());
    this.$dueBtn.on("click", () => this.onStudyDueToggle());
    this.$mode.on("change", () => this.onModeChange());
    this.$strength.on("change", () => this.onStrengthChange());
    this.$prev.on("click", () => this.stepMove(-1));
    this.$next.on("click", () => this.stepMove(1));
    this.$hint.on("click", () => this.handleHint());
    this.$reveal.on("click", () => this.handleRevealMove());
    this.$lichess.on("click", () => this.openLichessGame());
    this.$boardZoomIn.on("click", () => this.adjustBoardSize(1));
    this.$boardZoomOut.on("click", () => this.adjustBoardSize(-1));
    this.$sessionSummary.on("click", () => this.toggleSessionSelectors());
    this.$sessionSummary.on("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.toggleSessionSelectors();
      }
    });
  },
  openLichessGame() {
    const fen = this.chess ? this.chess.fen() : "start";
    const encodedFen = encodeURIComponent(fen).replace(/%2F/g, "/");
    const url = `https://lichess.org/analysis/${encodedFen}`;
    window.open(url, "_blank", "noopener");
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
      fetch(NODES_CSV).then((res) => res.text()),
      fetch(MISTAKE_TEMPLATES_CSV).then((res) => res.text())
    ];

    Promise.all(fetches)
      .then(([openingsText, linesText, nodesText, mistakesText]) => {
        this.data.openings = csvToObjects(openingsText);
        this.data.lines = csvToObjects(linesText);
        this.data.nodes = csvToObjects(nodesText);
        this.data.mistakeTemplates = csvToObjects(mistakesText);
        this.buildIndexes();
        this.initBoard();
        const defaultLine = this.pickDefaultLine();
        const defaultMode = this.selectDefaultMode();
        this.populateSelectors({
          openingId: defaultLine ? defaultLine.opening_id : null,
          lineId: defaultLine ? defaultLine.line_id : null,
          mode: defaultMode
        });
        this.$mode.val(defaultMode);
        this.onModeChange();
        this.showLoading(false);
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
    this.data.nodesByLineId = {};
    this.data.nodesById = {};
    this.data.childrenByParentKey = {};
    this.data.rootNodesByLineId = {};
    this.data.nodesByOpeningFen = {};
    this.data.linePriorityById = {};
    this.data.mistakeTemplatesByCode = {};

    this.data.openings.forEach((opening) => {
      this.data.openingsById[opening.opening_id] = opening;
    });

    this.data.lines.forEach((line) => {
      const key = line.opening_id;
      const normalizedDrillSide = normalizeDrillSide(line.drill_side);
      line.drill_side = normalizedDrillSide || "white";
      line.drill_side_missing = !normalizedDrillSide;
      if (line.drill_side_missing) {
        console.warn("Missing drill_side for line:", line.line_id);
      }
      this.data.linesById[line.line_id] = line;
      if (!this.data.linesByOpeningId[key]) {
        this.data.linesByOpeningId[key] = [];
      }
      this.data.linesByOpeningId[key].push(line);
      const priority = parseFloat(line.line_priority || "1");
      this.data.linePriorityById[line.line_id] = Number.isFinite(priority) && priority > 0 ? priority : 1;
    });

    this.data.nodes.forEach((node) => {
      const lineId = node.line_id;
      if (!lineId) {
        return;
      }
      const nodeKey = getNodeKey(lineId, node.node_id);
      node._key = nodeKey;
      node._parent_key = node.parent_node_id ? getNodeKey(lineId, node.parent_node_id) : null;
      if (!this.data.nodesByLineId[lineId]) {
        this.data.nodesByLineId[lineId] = [];
      }
      this.data.nodesByLineId[lineId].push(node);
      this.data.nodesById[nodeKey] = node;
      const parentKey = node.parent_node_id ? node._parent_key : getNodeKey(lineId, "ROOT");
      if (!this.data.childrenByParentKey[parentKey]) {
        this.data.childrenByParentKey[parentKey] = [];
      }
      this.data.childrenByParentKey[parentKey].push(nodeKey);
      if (!node.parent_node_id) {
        if (!this.data.rootNodesByLineId[lineId]) {
          this.data.rootNodesByLineId[lineId] = [];
        }
        this.data.rootNodesByLineId[lineId].push(nodeKey);
      }
    });

    Object.keys(this.data.childrenByParentKey).forEach((parentKey) => {
      this.data.childrenByParentKey[parentKey].sort((aKey, bKey) => {
        const aNode = this.data.nodesById[aKey];
        const bNode = this.data.nodesById[bKey];
        return this.compareNodesDeterministic(aNode, bNode);
      });
    });

    this.data.mistakeTemplates.forEach((tmpl) => {
      this.data.mistakeTemplatesByCode[tmpl.mistake_code] = tmpl;
    });

    this.buildComputedFenIndexes();
  },
  compareNodesDeterministic(a, b) {
    const aNodeId = (a && a.node_id) || "";
    const bNodeId = (b && b.node_id) || "";
    const nodeCompare = aNodeId.localeCompare(bNodeId);
    if (nodeCompare !== 0) {
      return nodeCompare;
    }
    return ((a && a.move_uci) || "").localeCompare((b && b.move_uci) || "");
  },
  compareNodesByPreference(a, b) {
    const sessionLineId = this.state.sessionLineId;
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
    return this.compareNodesDeterministic(a, b);
  },
  buildComputedFenIndexes() {
    this.data.nodesByOpeningFen = {};
    const chess = new Chess();

    this.data.lines.forEach((line) => {
      const lineId = line.line_id;
      const opening = this.data.openingsById[line.opening_id];
      const startFen = line.start_fen || (opening ? opening.starting_fen : "") || "start";
      const rootKeys = this.data.rootNodesByLineId[lineId] || [];
      rootKeys.forEach((rootKey) => {
        this.traverseNodeFen(line, rootKey, startFen, 1, chess);
      });
    });

    Object.keys(this.data.nodesByOpeningFen).forEach((openingId) => {
      const fenMap = this.data.nodesByOpeningFen[openingId];
      Object.keys(fenMap).forEach((fenKey) => {
        fenMap[fenKey].sort((aKey, bKey) => {
          const aNode = this.data.nodesById[aKey];
          const bNode = this.data.nodesById[bKey];
          return this.compareNodesByPreference(aNode, bNode);
        });
      });
    });
  },
  traverseNodeFen(line, nodeKey, fenBefore, depth, chess) {
    const node = this.data.nodesById[nodeKey];
    if (!node) {
      return;
    }
    node._fen_before = fenBefore;
    node._fen_key = normalizeFen(fenBefore);
    node._depth = depth;
    if (!loadFenForChess(chess, fenBefore)) {
      console.warn("Failed to load FEN for node:", node.node_id, fenBefore);
      return;
    }
    const move = applyMoveUCI(chess, node.move_uci);
    if (!move) {
      console.warn("Illegal move in node:", line.line_id, node.node_id, node.move_uci);
      return;
    }
    const afterFen = chess.fen();
    node._san = move.san || "";

    const openingId = line.opening_id;
    if (openingId) {
      if (!this.data.nodesByOpeningFen[openingId]) {
        this.data.nodesByOpeningFen[openingId] = {};
      }
      const normalizedFen = node._fen_key;
      if (!this.data.nodesByOpeningFen[openingId][normalizedFen]) {
        this.data.nodesByOpeningFen[openingId][normalizedFen] = [];
      }
      this.data.nodesByOpeningFen[openingId][normalizedFen].push(node._key);
    }

    const children = this.data.childrenByParentKey[nodeKey] || [];
    children.forEach((childKey) => {
      this.traverseNodeFen(line, childKey, afterFen, depth + 1, chess);
    });
  },
  getLeafDescendants(lineId, fromNodeKey) {
    const leaves = [];
    const startKeys = fromNodeKey
      ? [fromNodeKey]
      : (this.data.rootNodesByLineId[lineId] || []);
    const stack = [...startKeys];
    while (stack.length) {
      const key = stack.pop();
      const children = this.data.childrenByParentKey[key] || [];
      if (!children.length) {
        leaves.push(key);
      } else {
        children.forEach((childKey) => stack.push(childKey));
      }
    }
    return leaves;
  },
  buildPathToRoot(nodeKey) {
    const path = [];
    let currentKey = nodeKey;
    while (currentKey) {
      const node = this.data.nodesById[currentKey];
      if (!node) {
        break;
      }
      path.push(currentKey);
      currentKey = node._parent_key || null;
    }
    return path.reverse();
  },
  pickPreferredLeaf(leafKeys) {
    if (!leafKeys.length) {
      return null;
    }
    const depths = leafKeys.map((key) => {
      const node = this.data.nodesById[key];
      return node ? node._depth || 0 : 0;
    });
    const maxDepth = Math.max(...depths);
    const deepest = leafKeys.filter((key) => {
      const node = this.data.nodesById[key];
      return node && (node._depth || 0) === maxDepth;
    });
    return deepest[Math.floor(Math.random() * deepest.length)];
  },
  buildSessionPlan(orderKeys) {
    const plan = {
      order: orderKeys,
      expectedByFenKey: {},
      depthByFenKey: {},
      totalPlies: orderKeys.length
    };
    orderKeys.forEach((nodeKey, index) => {
      const node = this.data.nodesById[nodeKey];
      if (!node || !node._fen_key) {
        return;
      }
      plan.expectedByFenKey[node._fen_key] = nodeKey;
      plan.depthByFenKey[node._fen_key] = index;
    });
    return plan;
  },
  buildSessionPlanFromRoot(lineId) {
    const leafKeys = this.getLeafDescendants(lineId);
    const leafKey = this.pickPreferredLeaf(leafKeys);
    if (!leafKey) {
      return null;
    }
    const path = this.buildPathToRoot(leafKey);
    return this.buildSessionPlan(path);
  },
  buildSessionPlanFromNode(nodeKey) {
    const node = this.data.nodesById[nodeKey];
    if (!node) {
      return null;
    }
    const leafKeys = this.getLeafDescendants(node.line_id, nodeKey);
    const leafKey = this.pickPreferredLeaf(leafKeys);
    if (!leafKey) {
      return null;
    }
    const path = this.buildPathToRoot(leafKey);
    const startIndex = path.indexOf(nodeKey);
    if (startIndex === -1) {
      return this.buildSessionPlan(path);
    }
    return this.buildSessionPlan(path.slice(startIndex));
  },
  syncCurrentDepthFromFen() {
    const plan = this.state.sessionPlan;
    if (!plan) {
      this.state.currentDepth = -1;
      return false;
    }
    const fenKey = normalizeFen(this.chess.fen());
    if (plan.depthByFenKey[fenKey] !== undefined) {
      this.state.currentDepth = plan.depthByFenKey[fenKey];
      return true;
    }
    this.state.currentDepth = -1;
    return false;
  },
  findTranspositionCandidate(fenKey) {
    const candidates = this.getNodesForOpeningFenKey(this.state.openingId, fenKey);
    return this.pickBestCandidate(candidates, this.state.sessionLineId);
  },
  switchSessionToNode(node, options = {}) {
    if (!node) {
      return;
    }
    const { announce = false } = options;
    this.state.sessionLineId = node.line_id;
    this.state.lineId = node.line_id;
    this.$line.val(node.line_id);
    const line = this.data.linesById[node.line_id] || null;
    const plan = this.buildSessionPlanFromNode(node._key);
    this.state.sessionPlan = plan;
    this.syncCurrentDepthFromFen();
    this.applyLineSide(line);
    this.setLineStatus(line);
    if (announce && line) {
      const name = line.line_name || line.line_id;
      this.setStatus(`Transposition detected → switched to ${name}.`);
    }
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
  toggleSessionSelectors(force) {
    if (!this.$sessionSelectors || !this.$sessionSelectors.length) {
      return;
    }
    const isOpen = !this.$sessionSelectors.prop("hidden");
    const nextState = typeof force === "boolean" ? force : !isOpen;
    this.$sessionSelectors.prop("hidden", !nextState);
    this.$sessionSummary.attr("aria-expanded", nextState);
  },
  pickDefaultLine() {
    const openings = this.data.openings.filter((o) => isTrue(o.published));
    const openingIds = new Set(openings.map((opening) => opening.opening_id));
    const candidateLines = this.data.lines.filter((line) => openingIds.has(line.opening_id));
    if (!candidateLines.length) {
      return null;
    }
    return weightedPick(candidateLines, (line) => this.getLineSelectionWeight(line, line.opening_id));
  },
  selectDefaultMode() {
    const openings = this.data.openings.filter((o) => isTrue(o.published));
    const openingIds = new Set(openings.map((opening) => opening.opening_id));
    const candidateLines = this.data.lines.filter((line) => openingIds.has(line.opening_id));
    if (!candidateLines.length) {
      return "learning";
    }
    const srData = loadSR();
    const hasUnlearned = candidateLines.some((line) => {
      const sr = ensureSRDefaults(srData[getLineKey(line.opening_id, line.line_id)]);
      return (sr.stats.learned || 0) === 0;
    });
    return hasUnlearned ? "learning" : "practice";
  },
  populateSelectors(defaults = {}) {
    const openings = this.data.openings.filter((o) => isTrue(o.published));
    this.$opening.empty();
    openings.forEach((opening) => {
      this.$opening.append(
        $("<option>").val(opening.opening_id).text(opening.opening_name || opening.opening_id)
      );
    });
    if (openings.length === 0) {
      return;
    }
    const openingId = defaults.openingId || openings[0].opening_id;
    this.state.openingId = openingId;
    this.$opening.val(openingId);
    this.state.lineId = defaults.lineId || "any";
    this.populateLines(defaults.lineId);
  },
  populateLines(preferredLineId) {
    const lines = this.data.linesByOpeningId[this.state.openingId] || [];
    const filteredLines = this.getFilteredLines(lines);
    const displayLines = filteredLines.length ? filteredLines : lines;
    const currentSelection = preferredLineId || this.$line.val();

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
    this.populateLines(this.state.lineId);
    this.updateSideSelector();
    this.$strengthField.toggle(this.state.mode === "game");
    this.$hint.prop("disabled", this.state.mode === "game");
    this.$reveal.prop("disabled", this.state.mode !== "practice");
    this.$dueBtn.toggle(this.state.mode === "practice");
    this.$dueBtn.text(this.state.studyDueOnly ? "Study All Lines" : "Study Due Lines");
    this.setComment("Session ready.");
    this.prepareSession();
  },
  onSideChange(nextSide) {
    const normalizedSide = normalizeDrillSide(nextSide);
    if (!normalizedSide) {
      return;
    }
    this.state.userSide = normalizedSide;
    this.board.orientation(this.state.userSide);
    this.updateSideStatus();
    if (this.state.mode === "game") {
      this.prepareSession();
    }
  },
  onStrengthChange() {
    if (this.state.mode === "game") {
      this.prepareSession();
    }
  },
  updateSideSelector() {
    const line = this.getActiveLine();
    if (this.state.mode === "learning" || this.state.mode === "practice") {
      this.applyLineSide(line);
    } else if (this.state.mode === "game") {
      this.applyLineSide(line);
    } else {
      this.state.userSide = "white";
      this.board.orientation(this.state.userSide);
      this.updateSideStatus();
    }
  },
  applyLineSide(line) {
    const drillSide = normalizeDrillSide(line && line.drill_side);
    this.state.userSide = drillSide || "white";
    this.board.orientation(this.state.userSide);
    this.updateSideStatus();
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
    this.state.sessionPlan = null;
    this.state.currentDepth = -1;
    this.state.mistakes = 0;
    this.state.wrongAttemptsForPly = 0;
    this.state.hintLevel = 0;
    this.state.revealStage = 0;
    this.state.hadLapse = false;
    this.state.completed = false;
    this.state.inBook = false;
    this.state.hintActive = false;
    this.state.bookPlyIndex = 0;
    this.state.bookMaxPlies = 0;
    this.state.engineBusy = false;
    this.state.sessionLineId = null;
    this.state.moveHistory = [];
    this.state.redoMoves = [];
    this.$engineEval.text("");
    this.clearSelection();
    this.clearHintHighlight();
    this.clearLastMoveHighlight();
    this.updateNavigationControls();
    this.updateWinProbability(0.5);

    const opening = this.getSelectedOpening();
    const line = this.resolveSessionLine(forceStart);
    const needsDrillSide = this.state.mode === "learning" || this.state.mode === "practice";
    if (needsDrillSide && line && line.drill_side_missing) {
      this.state.sessionActive = false;
      this.setLineStatus(line);
      this.setStatus("Line data is missing drill_side. Please update the lines feed with white/black.");
      this.setComment("Unable to start until drill_side is set for this line.");
      return;
    }
    this.applyLineSide(line);
    let fen = "start";
    if (this.state.mode === "game") {
      if (line && line.start_fen) {
        fen = line.start_fen;
      } else {
        fen = opening && opening.starting_fen ? opening.starting_fen : "start";
      }
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
      this.setLineStatus(line);
      if (line) {
        this.state.sessionPlan = this.buildSessionPlanFromRoot(line.line_id);
        this.syncCurrentDepthFromFen();
      }
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
    this.state.bookPlyIndex = 0;
    const maxPlies = opening && opening.book_max_plies_game_mode ? parseInt(opening.book_max_plies_game_mode, 10) : 0;
    this.state.bookMaxPlies = Number.isFinite(maxPlies) ? maxPlies : 0;
    const fenKey = normalizeFen(this.chess.fen());
    this.state.inBook = this.state.bookMaxPlies > 0 && this.getBookCandidatesForFenKey(fenKey).length > 0;

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
        const expected = this.getExpectedNode();
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
    const expected = this.getExpectedNode();
    if (!expected) {
      this.setStatus("Line complete.");
      return "snapback";
    }

    const fenKeyBefore = expected._fen_key || normalizeFen(this.chess.fen());
    const legalMove = this.chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion
    });

    if (!legalMove) {
      this.playSound("error");
      return "snapback";
    }

    const fenKeyAfter = normalizeFen(this.chess.fen());
    const plan = this.state.sessionPlan;
    const planDepth = plan ? plan.depthByFenKey[fenKeyAfter] : undefined;
    const currentDepth = Number.isFinite(this.state.currentDepth) ? this.state.currentDepth : -1;
    const opening = this.getSelectedOpening();
    const allowTranspositions = opening && isTrue(opening.allow_transpositions);
    const isExpectedMove = uci === expected.move_uci;
    const isTranspositionWithinPlan = allowTranspositions && Number.isFinite(planDepth) && planDepth > currentDepth;

    if (!isExpectedMove && !isTranspositionWithinPlan) {
      const branchNode = this.findMistakeBranchNode(fenKeyBefore, uci, expected);
      if (branchNode) {
        this.handleMistakeBranchJump(branchNode, expected, uci, legalMove);
        return;
      }
      this.chess.undo();
      this.handleWrongMove(uci, expected);
      this.playSound("error");
      return "snapback";
    }

    this.playMoveSound(legalMove);
    this.recordMove(uci, legalMove);
    if (isTranspositionWithinPlan) {
      this.state.currentDepth = planDepth;
    } else {
      this.syncCurrentDepthFromFen();
    }
    this.state.hintLevel = 0;
    this.state.wrongAttemptsForPly = 0;
    this.state.revealStage = 0;
    this.updateNavigationControls();
    this.updateLastMoveHighlight();
    this.setLineStatus(this.getActiveLine());
    if (this.state.mode === "learning") {
      this.showLearningExplain(expected);
    } else {
      this.showPracticeCorrect(expected);
    }
    this.checkLineComplete();
    const turn = this.chess.turn() === "w" ? "white" : "black";
    if (turn !== this.state.userSide) {
      this.setStatus("Opponent thinking...");
      this.scheduleAutoPlay();
    } else {
      this.setStatus("Your move.");
    }
    return;
  },
  findMistakeBranchNode(fenKeyBefore, uci, expected) {
    const openingId = this.state.openingId;
    const candidates = this.getNodesForOpeningFenKey(openingId, fenKeyBefore);
    const matches = candidates.filter((node) => node.move_uci === uci);
    if (!matches.length) {
      return null;
    }
    const sameLine = expected ? matches.filter((node) => node.line_id === expected.line_id) : [];
    const pool = sameLine.length ? sameLine : matches;
    const highestPriority = Math.max(...pool.map((node) => this.data.linePriorityById[node.line_id] || 1));
    const topPriority = pool.filter((node) => (this.data.linePriorityById[node.line_id] || 1) === highestPriority);
    return topPriority[Math.floor(Math.random() * topPriority.length)];
  },
  handleMistakeBranchJump(branchNode, expected, uci, legalMove) {
    this.state.mistakes += 1;
    this.state.wrongAttemptsForPly += 1;
    this.state.hadLapse = true;
    const mistakeMessage = expected ? this.lookupMistake(uci, expected) : "";
    if (mistakeMessage) {
      this.setComment(mistakeMessage);
    } else {
      this.setComment("Different branch selected. We'll follow this line.");
    }
    this.setStatus("Switching to the selected branch.");

    this.playMoveSound(legalMove);
    this.recordMove(uci, legalMove);
    this.switchSessionToNode(branchNode, { announce: false });
    this.state.hintLevel = 0;
    this.state.revealStage = 0;
    this.state.wrongAttemptsForPly = 0;
    this.updateNavigationControls();
    this.updateLastMoveHighlight();
    this.board.position(this.chess.fen());
    this.startLiveAnalysis();
    const turn = this.chess.turn() === "w" ? "white" : "black";
    if (turn !== this.state.userSide) {
      this.scheduleAutoPlay();
    } else {
      this.setStatus("Your move.");
    }
  },
  handleGameMove(uci, promotion) {
    const fenKeyBefore = normalizeFen(this.chess.fen());
    const bookCandidates = this.getBookCandidatesForFenKey(fenKeyBefore);
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
    this.updateNavigationControls();
    this.updateLastMoveHighlight();

    if (this.state.inBook) {
      const maxReached = this.state.bookPlyIndex >= this.state.bookMaxPlies;
      if (maxReached || bookCandidates.length === 0) {
        this.state.inBook = false;
      } else {
        const matchesCandidate = bookCandidates.some((candidate) => candidate.move_uci === uci);
        if (!matchesCandidate) {
          this.state.inBook = false;
        } else {
          this.state.bookPlyIndex += 1;
          if (this.state.bookPlyIndex >= this.state.bookMaxPlies) {
            this.state.inBook = false;
          }
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
    const fenKey = normalizeFen(this.chess.fen());
    const candidates = this.getBookCandidatesForFenKey(fenKey);
    const expected = this.pickBookNode(candidates);
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
    } else {
      const nextCandidates = this.getBookCandidatesForFenKey(normalizeFen(this.chess.fen()));
      if (!nextCandidates.length) {
        this.state.inBook = false;
      }
    }
    this.updateNavigationControls();
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
      this.updateNavigationControls();
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
    const mistakeMessage = this.lookupMistake(uci, row);
    if (mistakeMessage) {
      this.setComment(mistakeMessage);
    } else {
      const expectedSan = row ? this.getExpectedSan(row) : "";
      const hint = expectedSan ? ` Hint: ${expectedSan}` : "";
      this.setComment(`Not in this repertoire.${hint}`);
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
    const expected = this.getExpectedNode();
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
    this.syncCurrentDepthFromFen();
    this.state.wrongAttemptsForPly = 0;
    this.state.revealStage = 0;
    this.board.position(this.chess.fen());
    this.startLiveAnalysis();
    this.updateNavigationControls();
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
      if (this.state.mode === "game") {
        this.state.inBook = false;
      }
    }
    if (this.state.mode === "learning" || this.state.mode === "practice") {
      this.updateTrainingPositionState();
    }
    this.board.position(this.chess.fen());
    this.startLiveAnalysis();
    this.updateNavigationControls();
    this.updateLastMoveHighlight();
    this.clearHintHighlight();
    if (this.state.mode === "learning" || this.state.mode === "practice") {
      this.setLineStatus(this.getActiveLine());
    }
    this.setStatus("Reviewing moves.");
  },
  updateTrainingPositionState() {
    const opening = this.getSelectedOpening();
    const allowTranspositions = opening && isTrue(opening.allow_transpositions);
    const fenKey = normalizeFen(this.chess.fen());
    if (allowTranspositions && this.state.sessionPlan) {
      const depth = this.state.sessionPlan.depthByFenKey[fenKey];
      if (!Number.isFinite(depth)) {
        const transposed = this.findTranspositionCandidate(fenKey);
        if (transposed) {
          this.switchSessionToNode(transposed, { announce: false });
        }
      }
    }
    this.syncCurrentDepthFromFen();
  },
  showLearningPrompt() {
    if (this.state.mode !== "learning") {
      return;
    }
    const expected = this.getExpectedNode();
    if (expected) {
      this.setComment(expected.learn_prompt || "Find the next move.");
    }
  },
  showLearningExplain(row) {
    this.setComment("Good move. Continue.");
  },
  showPracticeCorrect(row) {
    this.setComment("Correct.");
  },
  getExpectedSan(row) {
    if (!row) {
      return "";
    }
    if (row._san) {
      return row._san;
    }
    return row.move_uci || "";
  },
  handleHint() {
    const row = this.getExpectedNode();
    if (!row) {
      return;
    }
    if (this.state.hintActive) {
      this.clearHintHighlight();
      this.setComment(this.state.lastCoachComment || "Keep going.");
      this.state.hintActive = false;
      return;
    }
    const expectedSan = this.getExpectedSan(row);
    if (expectedSan) {
      this.setComment(`Hint: ${expectedSan}`, { isHint: true });
    } else {
      this.setComment("Hint: make the expected move.", { isHint: true });
    }
    this.state.hintActive = true;
  },
  handleRevealMove() {
    if (this.state.mode !== "practice") {
      return;
    }
    const row = this.getExpectedNode();
    if (!row) {
      return;
    }
    const san = this.getExpectedSan(row) || row.move_uci;
    this.setComment(`Correct move: <strong>${san}</strong>`);
    this.state.revealStage = 2;
    this.state.hadLapse = true;
  },
  checkLineComplete() {
    if (this.state.completed) {
      return;
    }
    if (!this.state.sessionPlan) {
      return;
    }
    if (!this.getExpectedNode()) {
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
      this.$progressText.text("");
      return;
    }
    const key = getLineKey(this.state.openingId, line.line_id);
    const srData = loadSR();
    const sr = ensureSRDefaults(srData[key]);
    const reps = sr.reps || 0;
    const ease = sr.ease ? sr.ease.toFixed(2) : "2.50";
    const stats = sr.stats || { completed: 0, perfect: 0, learned: 0 };
    this.$progressText.text(
      `${stats.completed || 0} • Studied: ${stats.learned || 0} • Perfect: ${stats.perfect || 0} • Reps: ${reps} • Ease: ${ease}`
    );
  },
  updateSideStatus() {
    if (!this.$sideStatus || !this.$sideStatus.length) {
      return;
    }
    const sideLabel = this.state.userSide === "black" ? "Black" : "White";
    this.$sideStatus.text(`Training as ${sideLabel}`);
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
  getLineSelectionWeight(line, openingId = this.state.openingId) {
    const basePriority = this.data.linePriorityById[line.line_id] || 1;
    const srData = loadSR();
    const sr = ensureSRDefaults(srData[getLineKey(openingId, line.line_id)]);
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
  adjustBoardSize(direction) {
    const sizes = [420, 480, 520, 560, 600];
    if (!Number.isFinite(this.state.boardSizeIndex)) {
      this.state.boardSizeIndex = 2;
    }
    const nextIndex = Math.max(0, Math.min(sizes.length - 1, this.state.boardSizeIndex + direction));
    this.state.boardSizeIndex = nextIndex;
    const nextSize = `${sizes[nextIndex]}px`;
    document.documentElement.style.setProperty("--board-size", nextSize);
    this.$board.css("--board-size", nextSize);
    if (this.board && this.board.resize) {
      this.board.resize();
    }
  },
  updateNavigationControls() {
    const hasHistory = this.state.moveHistory.length > 0;
    const hasRedo = this.state.redoMoves.length > 0;
    this.$prev.prop("disabled", !hasHistory);
    this.$next.prop("disabled", !hasRedo);
  },
  updateWinProbabilityFromEval(evalData) {
    if (evalData && evalData.type === "mate") {
      const mateScore = evalData.value;
      const mateLabel = `#${mateScore > 0 ? Math.abs(mateScore) : `-${Math.abs(mateScore)}`}`;
      this.$winProbText.text(mateLabel);
      return;
    }
    const probability = evalToWinProbability(evalData, "white");
    this.updateWinProbability(probability);
  },
  updateWinProbability(probability) {
    const clamped = Math.max(0, Math.min(1, probability));
    const percent = Math.round(clamped * 100);
    this.$winProbText.text(`${percent}%`);
  },
  setStatus(text) {
    this.state.statusText = text;
    this.renderCoachComment();
  },
  setComment(html, options = {}) {
    this.state.previousCoachComment = this.state.currentCoachComment;
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
    const previous = this.state.previousCoachComment || "";
    const plainPrevious = previous.replace(/<[^>]*>/g, "").trim();
    const needsPrefix = this.state.statusText === "Your move." && !/^your move\b/i.test(plainBase);
    const prefix = needsPrefix ? "<strong>Your move:</strong> " : "";
    const previousHtml = plainPrevious
      ? `<div class="coach-message-previous">${plainPrevious}</div>`
      : "";
    this.$comment.html(
      `<div class="coach-message-stack"><div class="coach-message-current">${prefix}${base}</div>${previousHtml}</div>`
    );
  },
  setLineStatus(line) {
    if (!line) {
      const opening = this.getSelectedOpening();
      const openingName = opening ? opening.opening_name || opening.opening_id : "Opening";
      const modeLabel = formatModeLabel(this.state.mode);
      this.$lineStatus.text(`${openingName} • ${modeLabel}`);
      this.updateSideStatus();
      return;
    }
    const plan = this.state.sessionPlan;
    const total = plan ? plan.totalPlies : 0;
    const depth = Number.isFinite(this.state.currentDepth) ? this.state.currentDepth + 1 : 0;
    const ply = total ? Math.min(Math.max(depth, 1), total) : 0;
    const lineName = line.line_name || line.line_id;
    const opening = this.getSelectedOpening();
    const openingName = opening ? opening.opening_name || opening.opening_id : "Opening";
    const modeLabel = formatModeLabel(this.state.mode);
    if (total) {
      this.$lineStatus.text(`${openingName} • ${lineName} • Ply ${ply} of ${total} • ${modeLabel}`);
    } else {
      this.$lineStatus.text(`${openingName} • ${lineName} • ${modeLabel}`);
    }
    this.updateSideStatus();
  },
  getSelectedOpening() {
    return this.data.openingsById[this.state.openingId] || null;
  },
  getSelectedLine() {
    return this.getActiveLine();
  },
  getNodesForOpeningFenKey(openingId, fenKey) {
    const keys = (this.data.nodesByOpeningFen[openingId] || {})[fenKey] || [];
    return keys.map((key) => this.data.nodesById[key]).filter(Boolean);
  },
  getCandidateNodesForCurrentFen() {
    const normalized = normalizeFen(this.chess.fen());
    return this.getNodesForOpeningFenKey(this.state.openingId, normalized);
  },
  pickBestCandidate(candidates, preferredLineId) {
    if (!candidates.length) {
      return null;
    }
    const preferred = preferredLineId
      ? candidates.filter((candidate) => candidate.line_id === preferredLineId)
      : [];
    const pool = preferred.length ? preferred : candidates;
    const highestPriority = Math.max(...pool.map((candidate) => this.data.linePriorityById[candidate.line_id] || 1));
    const topPriority = pool.filter((candidate) => (this.data.linePriorityById[candidate.line_id] || 1) === highestPriority);
    return topPriority[Math.floor(Math.random() * topPriority.length)];
  },
  getExpectedNodeFromPlan() {
    const plan = this.state.sessionPlan;
    if (!plan) {
      return null;
    }
    const fenKey = normalizeFen(this.chess.fen());
    const nodeKey = plan.expectedByFenKey[fenKey];
    if (!nodeKey) {
      return null;
    }
    return this.data.nodesById[nodeKey] || null;
  },
  getExpectedNode() {
    const expected = this.getExpectedNodeFromPlan();
    if (expected) {
      return expected;
    }
    const opening = this.getSelectedOpening();
    const allowTranspositions = opening && isTrue(opening.allow_transpositions);
    if (!allowTranspositions) {
      return null;
    }
    const fenKey = normalizeFen(this.chess.fen());
    const transposed = this.findTranspositionCandidate(fenKey);
    if (!transposed) {
      return null;
    }
    this.switchSessionToNode(transposed, { announce: true });
    return this.getExpectedNodeFromPlan();
  },
  getBookCandidatesForFenKey(fenKey) {
    return this.getNodesForOpeningFenKey(this.state.openingId, fenKey);
  },
  pickBookNode(candidates) {
    if (!candidates.length) {
      return null;
    }
    return this.pickBestCandidate(candidates, this.state.sessionLineId);
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

function loadFenForChess(chess, fen) {
  try {
    chess.reset();
    if (fen && fen !== "start") {
      return chess.load(fen);
    }
    return true;
  } catch (error) {
    return false;
  }
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

function getNodeKey(lineId, nodeId) {
  return `${lineId}:${nodeId}`;
}

function normalizeDrillSide(value) {
  if (!value) {
    return "";
  }
  const normalized = value.toString().trim().toLowerCase();
  if (normalized === "white" || normalized === "black") {
    return normalized;
  }
  return "";
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
    const turn = fen.split(" ")[1];
    const adjusted = turn === "b" ? -value : value;
    const mateText = adjusted > 0 ? Math.abs(adjusted) : `-${Math.abs(adjusted)}`;
    return `Engine eval: #${mateText}`;
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

function formatModeLabel(mode) {
  switch (mode) {
    case "practice":
      return "Practice";
    case "game":
      return "Game";
    default:
      return "Learning";
  }
}

$(document).ready(() => {
  App.init();
});
