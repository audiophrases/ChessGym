/*
  ChessGym uses four JSON datasets:
  - openings: core opening metadata (opening_id, starting_fen, book_max_plies_game_mode, etc.).
  - lines: named training lines (opening_id, line_id, line_name, line_group, drill_side, start_fen, tags, moves_pgn).
  - nodes: per-position instructions and FEN lookup data (opening_id, line_id, node_id, parent_node_id, move_uci, learn_prompt, mistake_map, fen_before, fen_key, fen_after, fen_after_key).
  - mistake_templates: global messaging for mapped mistakes (mistake_code -> coach_message, why_wrong, hint).
*/

const OPPONENT_DELAY_MS = 500;
const PINNED_LINES_KEY = "chessgym.pinnedLines";
const SUGGESTION_API_BASE_KEY = "chessgym.suggestionApiBase";
const SUGGESTION_SUBMIT_TOKEN_KEY = "chessgym.suggestionSubmitToken";
const SUGGESTION_ADMIN_TOKEN_KEY = "chessgym.suggestionAdminToken";
const SUGGESTION_DRAFTS_KEY = "chessgym.suggestionDrafts";
const PUBLIC_SUGGESTION_API_BASE = "https://chessgym-suggestions.eugenime.workers.dev";
const THUMBNAIL_PLACEHOLDER_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const ADMIN_API_BASE = "/admin/api";
const LOCAL_DATA_BASE = "data";
const ADMIN_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
const AI_PROMPT_STYLE_RULES = [
  "Style Rules:",
  "For the study side: Start with a strong verb (Develop, Challenge, Strike, Sacrifice, Activate, Counter, Deliver, Capture, Reposition, etc.). Describe what the move accomplishes positionally and tactically, without directly naming the move or square unless necessary. Make it educational and insightful so the learner can infer the move from the description.",
  "For the opponent: Start with \"White\" or \"Black\" (whichever side the opponent is) and describe the move naturally, often highlighting typical human mistakes at intermediate/low ELO level (e.g. \"greedily\", \"prematurely\", \"awkwardly\", \"overextending\").",
  "Mention the opening name subtly at key moments (e.g. \"entering the Traxler Counterattack\", \"in this sharp Italian Game line\") for context, but do not overdo it.",
  "Use rich but concise language that conveys purpose, consequences, and strategic intent.",
  "Build tension and drama naturally, especially on tactical blows and checkmates.",
  "Keep a confident, instructive, and slightly motivational tone.",
  "",
  "Output only the code block with the list of sentences, nothing else."
].join("\n");

function isAdminMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("admin") === "1") {
      return true;
    }
    if (params.get("admin") === "0") {
      return false;
    }
    return ADMIN_HOSTS.has(window.location.hostname);
  } catch (error) {
    return false;
  }
}
const OPENING_HEADERS = ["opening_id", "opening_name", "side", "starting_fen", "description", "tags", "published", "book_max_plies_game_mode", "allow_transpositions"];
const LINE_HEADERS = ["opening_id", "line_id", "line_name", "line_group", "drill_side", "start_fen", "tags", "moves_pgn"];
const NODE_HEADERS = ["opening_id", "line_id", "node_id", "parent_node_id", "move_uci", "learn_prompt", "mistake_map", "fen_before", "fen_key", "fen_after", "fen_after_key"];

const TTS_EDGE_NUDGE_DISMISSED_KEY = "chessgym.ttsEdgeNudgeDismissed";

const TTS = {
  enabled: typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined" && typeof window.SpeechSynthesisUtterance !== "undefined",
  voice: null,
  voicesReady: false,
  lastSpoken: "",
  nudgeShown: false,
  qualityTags: ["Natural", "Neural", "Premium", "Online", "Enhanced"],
  pieceMap: { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight" },

  init() {
    if (!this.enabled) {
      return;
    }
    this.loadVoices();
    const onVoicesChanged = () => {
      this.loadVoices();
      this.maybeShowEdgeNudge();
    };
    if (typeof window.speechSynthesis.addEventListener === "function") {
      window.speechSynthesis.addEventListener("voiceschanged", onVoicesChanged);
    } else {
      window.speechSynthesis.onvoiceschanged = onVoicesChanged;
    }
    setTimeout(() => this.maybeShowEdgeNudge(), 1500);
  },

  loadVoices() {
    let voices = [];
    try {
      voices = window.speechSynthesis.getVoices() || [];
    } catch (e) {
      voices = [];
    }
    if (!voices.length) {
      return;
    }
    this.voicesReady = true;
    const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang || ""));
    const pool = english.length ? english : voices;
    let best = null;
    let bestScore = -1;
    pool.forEach((v) => {
      const name = v.name || "";
      let score = 0;
      this.qualityTags.forEach((tag, i) => {
        if (name.indexOf(tag) !== -1) {
          score = Math.max(score, this.qualityTags.length - i);
        }
      });
      if (/^en-US/i.test(v.lang || "")) {
        score += 0.5;
      }
      if (v.localService === false) {
        score += 0.25;
      }
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    });
    this.voice = best || pool[0];
    this.hasQualityVoice = bestScore >= 1;
  },

  isEdge() {
    return /\bEdg\//.test((typeof navigator !== "undefined" && navigator.userAgent) || "");
  },

  maybeShowEdgeNudge() {
    if (!this.enabled || this.nudgeShown || !this.voicesReady) {
      return;
    }
    if (this.hasQualityVoice || this.isEdge()) {
      this.nudgeShown = true;
      return;
    }
    try {
      if (window.localStorage && window.localStorage.getItem(TTS_EDGE_NUDGE_DISMISSED_KEY) === "1") {
        this.nudgeShown = true;
        return;
      }
    } catch (e) { /* ignore */ }
    this.nudgeShown = true;
    this.renderEdgeNudge();
  },

  renderEdgeNudge() {
    if (typeof document === "undefined" || !document.body) {
      return;
    }
    const banner = document.createElement("div");
    banner.className = "tts-edge-nudge";
    banner.setAttribute("role", "note");
    banner.innerHTML = '<span class="tts-edge-nudge-text">🔊 For the most natural coach voice, open ChessGym in <strong>Microsoft Edge</strong>.</span><button type="button" class="tts-edge-nudge-dismiss" aria-label="Dismiss">×</button>';
    const dismiss = () => {
      banner.remove();
      try { window.localStorage.setItem(TTS_EDGE_NUDGE_DISMISSED_KEY, "1"); } catch (e) { /* ignore */ }
    };
    banner.querySelector(".tts-edge-nudge-dismiss").addEventListener("click", dismiss);
    document.body.appendChild(banner);
  },

  normalize(text) {
    if (!text) {
      return "";
    }
    let s = String(text).replace(/<[^>]*>/g, " ");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    s = s.replace(/\bO-O-O\b|\b0-0-0\b/g, "castle queenside");
    s = s.replace(/\bO-O\b|\b0-0\b/g, "castle kingside");
    s = s.replace(/\b([KQRBN])([a-h]?[1-8]?)(x?)([a-h])([1-8])(?:=([QRBN]))?([+#])?/g, (_m, piece, _disamb, capt, file, rank, promo, check) => {
      const parts = [this.pieceMap[piece]];
      if (capt) parts.push("takes");
      parts.push(file.toUpperCase(), rank);
      if (promo) parts.push("promotes to", this.pieceMap[promo].toLowerCase());
      if (check === "+") parts.push("check");
      if (check === "#") parts.push("checkmate");
      return parts.join(" ");
    });
    s = s.replace(/\b([a-h])x([a-h])([1-8])(\s*e\.p\.)?([+#])?/g, (_m, fileFrom, fileTo, rank, ep, check) => {
      const parts = ["pawn", fileFrom.toUpperCase(), "takes", fileTo.toUpperCase(), rank];
      if (ep) parts.push("en passant");
      if (check === "+") parts.push("check");
      if (check === "#") parts.push("checkmate");
      return parts.join(" ");
    });
    s = s.replace(/(^|[\s(,;:.!?"'—–-])([a-h])([1-8])([+#])?(?=$|[\s.,;:!?")'—–-])/g, (_m, pre, file, rank, check) => {
      const parts = [file.toUpperCase(), rank];
      if (check === "+") parts.push("check");
      if (check === "#") parts.push("checkmate");
      return pre + parts.join(" ");
    });
    s = s.replace(/\s+/g, " ").trim();
    return s;
  },

  speak(text) {
    if (!this.enabled) {
      return;
    }
    const plain = this.normalize(text);
    if (!plain || plain === this.lastSpoken) {
      return;
    }
    this.lastSpoken = plain;
    try {
      window.speechSynthesis.cancel();
      const utter = new window.SpeechSynthesisUtterance(plain);
      if (this.voice) {
        utter.voice = this.voice;
        utter.lang = this.voice.lang || "en-US";
      } else {
        utter.lang = "en-US";
      }
      utter.rate = 1.0;
      utter.pitch = 1.0;
      utter.volume = 1.0;
      window.speechSynthesis.speak(utter);
    } catch (e) { /* ignore */ }
  },

  queue(text) {
    if (!this.enabled) {
      return;
    }
    const plain = this.normalize(text);
    if (!plain) {
      return;
    }
    try {
      const utter = new window.SpeechSynthesisUtterance(plain);
      if (this.voice) {
        utter.voice = this.voice;
        utter.lang = this.voice.lang || "en-US";
      } else {
        utter.lang = "en-US";
      }
      utter.rate = 1.0;
      utter.pitch = 1.0;
      utter.volume = 1.0;
      window.speechSynthesis.speak(utter);
    } catch (e) { /* ignore */ }
  },

  replay(text) {
    this.lastSpoken = "";
    this.speak(text);
  },

  stop() {
    if (!this.enabled) {
      return;
    }
    try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    this.lastSpoken = "";
  }
};

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
    nodesByFen: {},
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
    databaseTrace: [],
    engineReady: false,
    engineBusy: false,
    studyDueOnly: false,
    sessionLineId: null,
    selectedSquare: null,
    selectedPiece: null,
    dragSource: null,
    clickHandledInDragCycle: false,
    sessionActive: false,
    pendingAutoPlayTimer: null,
    pendingOpponentTimer: null,
    pendingAnalysisTimer: null,
    lastHintSquare: null,
    analysisFen: null,
    analysisActive: false,
    analysisSessionId: 0,
    statusText: "",
    lastCoachComment: "",
    winProbText: "⭘",
    winProbValue: null,
    winProbSourceLabel: "",
    winProbSourceDetail: "",
    analysisEnabled: false,
    engineEnabled: true,
    engineSessionId: 0,
    coachCommentBySide: {
      white: { current: "", previous: "" },
      black: { current: "", previous: "" }
    },
    promptHistoryByFenBySide: {},
    promptChainBySide: {
      white: { current: "", previous: "" },
      black: { current: "", previous: "" }
    },
    coachOverride: null,
    coachOverrideTimer: null,
    coachOverrideActive: false,
    hintActive: false,
    freeModeActive: false,
    freeModeSnapshot: null,
    lastFreeMovesText: "",
    boardSizeIndex: 2,
    outOfLine: false,
    pinnedLines: loadPinnedLines(),
    lineSearchQuery: "",
    linePinnedOnly: false,
  },
  chess: null,
  board: null,
  engine: null,
  sounds: {},
  thumbnailCache: new Map(),
  thumbnailVersions: new Map(),
  init() {
    this.configureSuggestionInboxFromUrl();
    this.cacheElements();
    this.initThumbnailPreview();
    this.bindEvents();
    this.updateFreeModeButton();
    this.setupAdminMode();
    this.showLoading(true);
    this.loadData();
    TTS.init();
  },
  cacheElements() {
    this.$openingButton = $("#openingSelectBtn");
    this.$openingList = $("#openingSelectList");
    this.$lineButton = $("#lineSelectBtn");
    this.$lineList = $("#lineSelectList");
    this.$dueBtn = $("#dueBtn");
    this.$lineSearchInput = $("#lineSearchInput");
    this.$pinnedLinesBtn = $("#pinnedLinesBtn");
    this.$lineSelectOptions = $("#lineSelectOptions");
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
    this.$free = $("#freeBtn");
    this.$flip = $("#flipBtn");
    this.$reveal = $("#revealBtn");
    this.$lichess = $("#lichessBtn");
    this.$suggestLine = $("#suggestLineBtn");
    this.$suggestionModal = $("#suggestionModal");
    this.$suggestionClose = $("#suggestionClose");
    this.$suggestionOpeningName = $("#suggestionOpeningName");
    this.$suggestionOpeningId = $("#suggestionOpeningId");
    this.$suggestionLineName = $("#suggestionLineName");
    this.$suggestionDrillSide = $("#suggestionDrillSide");
    this.$suggestionStartFen = $("#suggestionStartFen");
    this.$suggestionMoves = $("#suggestionMoves");
    this.$suggestionComment = $("#suggestionComment");
    this.$suggestionContact = $("#suggestionContact");
    this.$suggestionClear = $("#suggestionClear");
    this.$suggestionSaveDraft = $("#suggestionSaveDraft");
    this.$suggestionSubmit = $("#suggestionSubmit");
    this.$suggestionStatus = $("#suggestionStatus");
    this.$lookupBtn = $("#lookupBtn");
    this.$lookupModal = $("#lookupModal");
    this.$lookupClose = $("#lookupClose");
    this.$lookupInput = $("#lookupInput");
    this.$lookupClear = $("#lookupClear");
    this.$lookupSubmit = $("#lookupSubmit");
    this.$lookupStatus = $("#lookupStatus");
    this.$lookupResults = $("#lookupResults");
    this.$lookupSite = $("#lookupSite");
    this.$lookupUsername = $("#lookupUsername");
    this.$lookupFetchGames = $("#lookupFetchGames");
    this.$lookupGamesStatus = $("#lookupGamesStatus");
    this.$lookupGamesList = $("#lookupGamesList");
    this.$engineEval = $("#engineEval");
    this.$overlay = $("#loadingOverlay");
    this.$strengthField = $("#strengthField");
    this.$winProbText = $("#winProbText");
    this.$board = $("#board");
    this.$boardZoomIn = $("#boardZoomIn");
    this.$boardZoomOut = $("#boardZoomOut");
    this.$openingThumb = $("#openingThumb");
    this.$lineThumb = $("#lineThumb");
    this.$adminNewLineSection = $("#adminNewLineSection");
    this.$adminNewLineToggle = $("#adminNewLineToggle");
    this.$newLineOpeningId = $("#newLineOpeningId");
    this.$newLineOpeningName = $("#newLineOpeningName");
    this.$newLineName = $("#newLineName");
    this.$newLineId = $("#newLineId");
    this.$newLineDrillSide = $("#newLineDrillSide");
    this.$newLineNotation = $("#newLineNotation");
    this.$newLineTags = $("#newLineTags");
    this.$newLineOpeningNameList = $("#newLineOpeningNameList");
    this.$newLineStartFen = $("#newLineStartFen");
    this.$newLineMoves = $("#newLineMoves");
    this.$newLineCreateOpening = $("#newLineCreateOpening");
    this.$newLineGenerate = $("#newLineGenerate");
    this.$newLineCopyRows = $("#newLineCopyRows");
    this.$newLineAiPrompt = $("#newLineAiPrompt");
    this.$newLineSubmit = $("#newLineSubmit");
    this.$newLineOutput = $("#newLineOutput");
  },
  initThumbnailPreview() {
    let $preview = $("#thumbnailPreview");
    if (!$preview.length) {
      $preview = $("<div>")
        .attr("id", "thumbnailPreview")
        .addClass("thumbnail-preview hidden")
        .append(
          $("<img>")
            .addClass("thumbnail-preview-image")
            .attr("src", THUMBNAIL_PLACEHOLDER_SRC)
            .attr("alt", "")
        );
      $("body").append($preview);
    }
    this.$thumbnailPreview = $preview;
    this.$thumbnailPreviewImage = $preview.find("img");
  },
  bindEvents() {
    this.$openingButton.on("click", () => this.toggleSelectList("opening"));
    this.$lineButton.on("click", () => this.toggleSelectList("line"));
    this.$openingList.on("click", ".select-option", (event) => this.handleSelectOption(event, "opening"));
    this.$lineList.on("click", ".select-option", (event) => this.handleSelectOption(event, "line"));
    this.$openingList.on("mouseenter", ".select-option", (event) => this.showThumbnailPreview(event));
    this.$lineList.on("mouseenter", ".select-option", (event) => this.showThumbnailPreview(event));
    this.$openingList.on("mousemove", ".select-option", (event) => this.positionThumbnailPreview(event));
    this.$lineList.on("mousemove", ".select-option", (event) => this.positionThumbnailPreview(event));
    this.$openingList.on("mouseleave", ".select-option", () => this.hideThumbnailPreview());
    this.$lineList.on("mouseleave", ".select-option", () => this.hideThumbnailPreview());
    this.$dueBtn.on("click", () => this.onStudyDueToggle());
    this.$lineSearchInput.on("input", () => this.onLineSearchChange());
    this.$lineSearchInput.on("click", (event) => event.stopPropagation());
    this.$pinnedLinesBtn.on("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.togglePinnedLinesFilter();
    });
    this.$mode.on("change", () => this.onModeChange());
    this.$strength.on("change", () => this.onStrengthChange());
    this.$prev.on("click", () => this.stepMove(-1));
    this.$next.on("click", () => this.stepMove(1));
    this.$hint.on("click", () => this.handleHint());
    this.$free.on("click", () => this.handleFreeModeToggle());
    this.$flip.on("click", () => this.handleFlipBoard());
    this.$reveal.on("click", () => this.handleRevealMove());
    this.$lichess.on("click", () => this.openLichessGame());
    this.$suggestLine.on("click", () => this.openSuggestionModal());
    this.$suggestionClose.on("click", () => this.closeSuggestionModal());
    this.$suggestionModal.on("click", (event) => {
      if (event.target === this.$suggestionModal[0]) {
        this.closeSuggestionModal();
      }
    });
    this.$suggestionClear.on("click", () => this.clearSuggestionForm());
    this.$suggestionSaveDraft.on("click", () => this.saveSuggestionDraftFromForm());
    this.$suggestionSubmit.on("click", () => this.submitSuggestion());
    this.$lookupBtn.on("click", () => this.openLookupModal());
    this.$lookupClose.on("click", () => this.closeLookupModal());
    this.$lookupModal.on("click", (event) => {
      if (event.target === this.$lookupModal[0]) {
        this.closeLookupModal();
      }
    });
    this.$lookupClear.on("click", () => this.clearLookupForm());
    this.$lookupSubmit.on("click", () => this.runLookup());
    this.$lookupResults.on("click", "button[data-lookup-action='load']", (event) => {
      const $button = $(event.currentTarget);
      this.loadLineFromLookup($button.attr("data-opening-id"), $button.attr("data-line-id"));
    });
    this.$lookupFetchGames.on("click", () => this.fetchLookupGames());
    this.$lookupUsername.on("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.fetchLookupGames();
      }
    });
    this.$lookupGamesList.on("click", "button[data-lookup-game-index]", (event) => {
      const index = Number($(event.currentTarget).attr("data-lookup-game-index"));
      this.loadLookupGameByIndex(index);
    });
    this.$boardZoomIn.on("click", () => this.adjustBoardSize(1));
    this.$boardZoomOut.on("click", () => this.adjustBoardSize(-1));
    this.$comment.on("click", "#winProbPill", (event) => {
      event.preventDefault();
      this.toggleWinProbAnalysis();
    });
    this.$sessionSummary.on("click", () => this.toggleSessionSelectors());
    this.$sessionSummary.on("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.toggleSessionSelectors();
      }
    });
    this.$newLineName.on("input", () => this.syncNewLineIdFromName());
    this.$newLineId.on("input", () => this.$newLineId.data("manual", true));
    this.$newLineOpeningName.on("input", () => this.syncOpeningIdFromName());
    this.$newLineOpeningId.on("input", () => this.$newLineOpeningId.data("manual", true));
    this.$newLineGenerate.on("click", () => this.generateNewLineRows());
    this.$newLineCopyRows.on("click", () => this.copyNewLineRows());
    this.$newLineAiPrompt.on("click", () => this.copyNewLineAiPrompt());
    this.$newLineSubmit.on("click", () => this.submitNewLineWrite());
    $(document).on("click", (event) => this.handleDocumentClick(event));
    $(document).on("keydown", (event) => {
      if (this.shouldIgnoreNavigationKey(event)) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        this.stepMove(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        this.stepMove(1);
      }
    });
  },
  shouldIgnoreNavigationKey(event) {
    const target = event.target;
    if (!target) {
      return false;
    }
    if (target.isContentEditable) {
      return true;
    }
    const tag = target.tagName ? target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return true;
    }
    if ($(target).closest(".custom-select").length) {
      return true;
    }
    return $(target).closest("[contenteditable='true']").length > 0;
  },
  openLichessGame() {
    const fen = this.chess ? this.chess.fen() : "start";
    const encodedFen = encodeURIComponent(fen).replace(/%2F/g, "/");
    const url = `https://lichess.org/analysis/${encodedFen}`;
    window.open(url, "_blank", "noopener");
  },
  openNewLineModal() {
    if (!isAdminMode() || !this.$adminNewLineSection.length) {
      return;
    }
    if (this.$adminPanel && this.$adminPanel.hasClass("collapsed")) {
      this.$adminPanel.removeClass("collapsed");
      this.$adminToggle.attr("aria-expanded", "true");
    }
    const opening = this.getSelectedOpening();
    const activeLine = this.getActiveLine();
    const movesText = this.state.lastFreeMovesText || this.state.moveHistory.join(" ");
    this.$newLineOpeningId.val(opening ? opening.opening_id || "" : "").removeData("manual");
    this.$newLineOpeningName.val(opening ? opening.opening_name || "" : "").removeData("lastSlug");
    this.$newLineName.val("");
    this.$newLineId.val("").removeData("manual");
    this.$newLineName.removeData("lastSlug");
    this.$newLineDrillSide.val((activeLine && activeLine.drill_side) || this.state.userSide || "white");
    this.$newLineNotation.val("auto");
    if (this.$newLineTags && this.$newLineTags.length) {
      this.$newLineTags.val("");
    }
    this.$newLineStartFen.val(activeLine && activeLine.start_fen ? activeLine.start_fen : "");
    this.$newLineMoves.val(movesText);
    this.$newLineCreateOpening.prop("checked", false);
    this.$newLineOutput.text("Preview the local JSON write before adding the line.");
    this.populateOpeningNameDatalist();
    this.$adminNewLineSection.prop("open", true);
    this.$adminNewLineSection[0].scrollIntoView({ block: "start", behavior: "smooth" });
    this.$newLineName.trigger("focus");
  },
  closeNewLineModal() {
    if (this.$adminNewLineSection && this.$adminNewLineSection.length) {
      this.$adminNewLineSection.prop("open", false);
    }
  },
  openSuggestionModal(suggestion = null) {
    if (!this.$suggestionModal || !this.$suggestionModal.length) {
      return;
    }
    const opening = this.getSelectedOpening();
    const line = this.getActiveLine();
    const snapshot = this.state.freeModeSnapshot;
    const freeMoves = this.state.freeModeActive ? this.getFreeModeMoves().join(" ") : "";
    const movesText = suggestion
      ? (suggestion.moves_text || "")
      : (freeMoves || this.state.lastFreeMovesText || "");
    const startFen = suggestion
      ? (suggestion.start_fen || "")
      : ((snapshot && snapshot.fen && snapshot.fen !== "start") ? snapshot.fen : ((line && line.start_fen) || (opening && opening.starting_fen) || ""));

    this.$suggestionOpeningName.val(suggestion ? (suggestion.opening_name || "") : (opening ? opening.opening_name || "" : ""));
    this.$suggestionOpeningId.val(suggestion ? (suggestion.opening_id || "") : (opening ? opening.opening_id || "" : ""));
    this.$suggestionLineName.val(suggestion ? (suggestion.line_name || "") : "");
    this.$suggestionDrillSide.val(normalizeDrillSide(suggestion ? suggestion.drill_side : (line && line.drill_side)) || this.state.userSide || "white");
    this.$suggestionStartFen.val(startFen);
    this.$suggestionMoves.val(movesText);
    this.$suggestionComment.val(suggestion ? (suggestion.comment || "") : "");
    this.$suggestionContact.val(suggestion ? (suggestion.contact || "") : "");
    this.$suggestionStatus.text("");
    this.$suggestionModal.removeClass("hidden");
    this.$suggestionLineName.trigger("focus");
  },
  closeSuggestionModal() {
    if (this.$suggestionModal && this.$suggestionModal.length) {
      this.$suggestionModal.addClass("hidden");
    }
  },
  clearSuggestionForm() {
    this.$suggestionOpeningName.val("");
    this.$suggestionOpeningId.val("");
    this.$suggestionLineName.val("");
    this.$suggestionDrillSide.val(this.state.userSide || "white");
    this.$suggestionStartFen.val("");
    this.$suggestionMoves.val("");
    this.$suggestionComment.val("");
    this.$suggestionContact.val("");
    this.$suggestionStatus.text("");
    this.$suggestionLineName.trigger("focus");
  },
  openLookupModal() {
    if (!this.$lookupModal || !this.$lookupModal.length) {
      return;
    }
    this.$lookupStatus.text("");
    this.$lookupResults.empty();
    this.$lookupModal.removeClass("hidden");
    this.$lookupInput.trigger("focus");
  },
  closeLookupModal() {
    if (this.$lookupModal && this.$lookupModal.length) {
      this.$lookupModal.addClass("hidden");
    }
  },
  clearLookupForm() {
    this.$lookupInput.val("");
    this.$lookupStatus.text("");
    this.$lookupResults.empty();
    this.$lookupInput.trigger("focus");
  },
  runLookup() {
    const raw = (this.$lookupInput.val() || "").trim();
    if (!raw) {
      this.$lookupStatus.text("Paste a FEN or a game first.");
      this.$lookupResults.empty();
      return;
    }
    const fenGuess = extractFenFromInput(raw);
    try {
      if (fenGuess) {
        this.runPositionLookup(fenGuess);
      } else {
        this.runGameLookup(raw);
      }
    } catch (error) {
      this.$lookupStatus.text(error.message || "Could not read that input.");
      this.$lookupResults.empty();
    }
  },
  runPositionLookup(fenInput) {
    const chess = new Chess();
    if (!loadFenForChess(chess, padFenFields(fenInput))) {
      this.$lookupStatus.text("That FEN could not be read.");
      this.$lookupResults.empty();
      return;
    }
    const fullFen = chess.fen();
    const fenKey = normalizeFen(fullFen);
    const nodes = this.getNodesForFenKey(fenKey);
    const matches = this.summarizeNodesByLine(nodes);
    matches.sort((a, b) =>
      a.openingName.localeCompare(b.openingName, undefined, { sensitivity: "base" }) ||
      a.lineName.localeCompare(b.lineName, undefined, { sensitivity: "base" })
    );
    this.renderLookupPositionResults(fullFen, matches);
  },
  runGameLookup(rawText) {
    let parsed;
    try {
      parsed = parseStudyLineMoves(rawText, "auto", "start");
    } catch (error) {
      this.$lookupStatus.text(error.message || "Could not read those moves.");
      this.$lookupResults.empty();
      return;
    }
    if (!parsed.moves.length) {
      this.$lookupStatus.text("No moves found.");
      this.$lookupResults.empty();
      return;
    }
    const matches = this.findLineMatchesForMoves(parsed.moves);
    matches.sort((a, b) =>
      b.deepestDepth - a.deepestDepth ||
      b.contiguousFromStart - a.contiguousFromStart ||
      b.matchedPlies - a.matchedPlies
    );
    this.renderLookupGameResults(parsed.moves, matches);
  },
  summarizeNodesByLine(nodes) {
    const byLine = {};
    (nodes || []).forEach((node) => {
      const lineId = node.line_id;
      if (!lineId) {
        return;
      }
      const depth = node._depth || 0;
      if (!byLine[lineId] || depth < byLine[lineId].depth) {
        const line = this.data.linesById[lineId] || {};
        byLine[lineId] = {
          lineId,
          lineName: line.line_name || lineId,
          openingId: node.opening_id || line.opening_id || "",
          openingName: this.lookupOpeningName(node.opening_id || line.opening_id) || node.opening_id || "",
          depth
        };
      }
    });
    return Object.values(byLine);
  },
  findLineMatchesForMoves(moves) {
    const byLine = {};
    const ensureEntry = (node) => {
      const lineId = node.line_id;
      if (!lineId) {
        return null;
      }
      if (!byLine[lineId]) {
        const line = this.data.linesById[lineId] || {};
        byLine[lineId] = {
          lineId,
          lineName: line.line_name || lineId,
          openingId: node.opening_id || line.opening_id || "",
          openingName: this.lookupOpeningName(node.opening_id || line.opening_id) || node.opening_id || "",
          matchedPlies: 0,
          contiguousFromStart: 0,
          positionsMatched: 0,
          deepestDepth: 0,
          deepestGamePly: 0,
          _seenPositions: new Set()
        };
      }
      return byLine[lineId];
    };
    const recordPosition = (entry, fenKey, node, gamePly) => {
      if (!entry._seenPositions.has(fenKey)) {
        entry._seenPositions.add(fenKey);
        entry.positionsMatched += 1;
      }
      const depth = node._depth || 0;
      if (depth > entry.deepestDepth) {
        entry.deepestDepth = depth;
        entry.deepestGamePly = gamePly;
      }
    };
    moves.forEach((move, index) => {
      const fenKey = move.fenKey || normalizeFen(move.fenBefore);
      const playedUci = normalizeUci(move.uci);
      this.getNodesForFenKey(fenKey).forEach((node) => {
        const entry = ensureEntry(node);
        if (!entry) {
          return;
        }
        recordPosition(entry, fenKey, node, index);
        if (normalizeUci(node.move_uci) === playedUci) {
          entry.matchedPlies += 1;
          if (entry.contiguousFromStart === index) {
            entry.contiguousFromStart = index + 1;
          }
        }
      });
    });
    const lastMove = moves[moves.length - 1];
    if (lastMove) {
      const finalFenKey = lastMove.fenAfterKey || normalizeFen(lastMove.fenAfter);
      this.getNodesForFenKey(finalFenKey).forEach((node) => {
        const entry = ensureEntry(node);
        if (entry) {
          recordPosition(entry, finalFenKey, node, moves.length);
        }
      });
    }
    return Object.values(byLine)
      .filter((entry) => entry.matchedPlies > 0 || entry.deepestDepth > 1)
      .map((entry) => {
        delete entry._seenPositions;
        return entry;
      });
  },
  renderLookupPositionResults(fullFen, matches) {
    this.$lookupResults.empty();
    const encodedFen = encodeURIComponent(fullFen).replace(/%2F/g, "/");
    const $summary = $("<p>").addClass("lookup-summary").text(
      matches.length
        ? `${matches.length} line${matches.length === 1 ? "" : "s"} reach this exact position.${matches.length > 30 ? " Showing the first 30." : ""}`
        : "No lines in the library reach this exact position."
    );
    this.$lookupStatus.text("");
    this.$lookupResults.append($summary);
    this.$lookupResults.append(
      $("<a>").attr({ href: `https://lichess.org/analysis/${encodedFen}`, target: "_blank", rel: "noopener" })
        .addClass("lookup-lichess-link").text("Open this position on Lichess")
    );
    matches.slice(0, 30).forEach((match) => {
      this.$lookupResults.append(this.buildLookupMatchCard({
        openingName: match.openingName,
        lineName: match.lineName,
        openingId: match.openingId,
        lineId: match.lineId,
        metaText: `Occurs at move ${Math.ceil(match.depth / 2)}${match.depth % 2 === 1 ? " (White)" : " (Black)"} in this line.`
      }));
    });
  },
  renderLookupGameResults(moves, matches) {
    this.$lookupResults.empty();
    this.$lookupStatus.text("");
    this.$lookupResults.append(
      $("<p>").addClass("lookup-summary").text(`Parsed ${moves.length} move${moves.length === 1 ? "" : "s"} from your game. Lines are matched by position, so transpositions are detected too.`)
    );
    if (!matches.length) {
      this.$lookupResults.append(
        $("<p>").addClass("lookup-empty").text("No positions from this game were found in the library.")
      );
      return;
    }
    matches.slice(0, 8).forEach((match, index) => {
      const total = moves.length;
      const followed = match.contiguousFromStart;
      let metaText;
      if (match.deepestDepth > followed + 1) {
        const gamePlies = match.deepestGamePly;
        const linePlies = match.deepestDepth - 1;
        metaText = `Transposition: after ${gamePlies} move${gamePlies === 1 ? "" : "s"} your game reaches the position this line has after ${linePlies} move${linePlies === 1 ? "" : "s"} — different move order, ${match.positionsMatched} shared position${match.positionsMatched === 1 ? "" : "s"}.`;
        if (followed > 0) {
          metaText = `Follows book for ${followed} of ${total} moves. ${metaText}`;
        }
      } else {
        metaText = `Follows book for ${followed} of ${total} move${total === 1 ? "" : "s"}.`;
        if (followed < total) {
          const divergeFenKey = normalizeFen(moves[followed].fenBefore);
          const bookNode = this.getNodesForFenKey(divergeFenKey).find((node) => node.line_id === match.lineId);
          const playedSan = moves[followed].san;
          if (bookNode && bookNode._san) {
            metaText += ` Diverges at move ${Math.ceil((followed + 1) / 2)}: you played ${playedSan}, the line continues ${bookNode._san}.`;
          }
        } else {
          metaText += " Matches this line all the way through.";
        }
      }
      const $card = this.buildLookupMatchCard({
        openingName: match.openingName,
        lineName: match.lineName,
        openingId: match.openingId,
        lineId: match.lineId,
        metaText,
        best: index === 0
      });
      this.$lookupResults.append($card);
    });
  },
  buildLookupMatchCard(options) {
    const $card = $("<article>").addClass("lookup-match").toggleClass("lookup-match-best", !!options.best);
    const $header = $("<div>").addClass("lookup-match-header");
    $header.append($("<span>").addClass("lookup-match-title").text(`${options.openingName} — ${options.lineName}`));
    if (options.best) {
      $header.append($("<span>").addClass("lookup-match-badge").text("Best match"));
    }
    $card.append($header);
    $card.append($("<p>").addClass("lookup-match-meta").text(options.metaText || ""));
    const $actions = $("<div>").addClass("lookup-match-actions");
    $actions.append(
      $("<button>").attr({ type: "button", "data-lookup-action": "load", "data-opening-id": options.openingId, "data-line-id": options.lineId })
        .addClass("ghost").text("Load line")
    );
    $card.append($actions);
    return $card;
  },
  loadLineFromLookup(openingId, lineId) {
    if (!lineId) {
      return;
    }
    this.closeLookupModal();
    if (openingId && openingId !== this.state.openingId) {
      this.onOpeningChange(openingId);
    }
    this.onLineChange(lineId);
  },
  fetchLookupGames() {
    const site = (this.$lookupSite.val() || "chesscom").trim();
    const username = (this.$lookupUsername.val() || "").trim();
    if (!username) {
      this.$lookupGamesStatus.text("Enter a username first.");
      return;
    }
    this.lookupFetchedGames = [];
    this.$lookupGamesList.empty();
    this.$lookupGamesStatus.text("Loading recent games…");
    this.state.lookupRequestId = (this.state.lookupRequestId || 0) + 1;
    const requestId = this.state.lookupRequestId;
    const request = site === "lichess" ? fetchLichessGames(username) : fetchChessComGames(username);
    request
      .then((games) => {
        if (requestId !== this.state.lookupRequestId) {
          return;
        }
        this.lookupFetchedGames = games;
        this.renderLookupGamesList(site, username, games);
      })
      .catch((error) => {
        if (requestId !== this.state.lookupRequestId) {
          return;
        }
        this.$lookupGamesStatus.text(error.message || "Could not load games.");
      });
  },
  renderLookupGamesList(site, username, games) {
    this.$lookupGamesList.empty();
    if (!games.length) {
      this.$lookupGamesStatus.text(`No recent games found for "${username}" on ${site === "lichess" ? "Lichess" : "Chess.com"}.`);
      return;
    }
    this.$lookupGamesStatus.text(`${games.length} recent game${games.length === 1 ? "" : "s"} — click one to find matching lines.`);
    games.forEach((game, index) => {
      const $row = $("<button>").attr({ type: "button", "data-lookup-game-index": index }).addClass("lookup-game-row");
      const dateLabel = game.date ? game.date.toLocaleDateString() : "";
      const sideLabel = game.userSide ? `You: ${game.userSide === "white" ? "White" : "Black"}` : "";
      $row.append($("<span>").addClass("lookup-game-main").text(`${game.white} vs ${game.black}`));
      $row.append($("<span>").addClass("lookup-game-meta").text(
        [dateLabel, game.timeClass, sideLabel, game.resultLabel].filter(Boolean).join(" · ")
      ));
      this.$lookupGamesList.append($row);
    });
  },
  loadLookupGameByIndex(index) {
    const game = (this.lookupFetchedGames || [])[index];
    if (!game) {
      return;
    }
    const text = game.pgn || game.moves || "";
    if (!text) {
      return;
    }
    this.$lookupInput.val(text);
    this.runLookup();
    if (this.$lookupResults && this.$lookupResults.length) {
      this.$lookupResults[0].scrollIntoView({ block: "nearest" });
    }
  },
  configureSuggestionInboxFromUrl() {
    let params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (error) {
      return;
    }
    const settings = [
      ["suggestion_api", SUGGESTION_API_BASE_KEY],
      ["suggestion_submit_token", SUGGESTION_SUBMIT_TOKEN_KEY],
      ["suggestion_admin_token", SUGGESTION_ADMIN_TOKEN_KEY]
    ];
    let changed = false;
    settings.forEach(([paramName, storageKey]) => {
      const value = params.get(paramName);
      if (!value) {
        return;
      }
      safeLocalStorageSet(storageKey, value);
      params.delete(paramName);
      changed = true;
    });
    if (changed && window.history && window.history.replaceState) {
      const nextQuery = params.toString();
      const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash || ""}`;
      window.history.replaceState({}, document.title, nextUrl);
    }
  },
  buildSuggestionPayloadFromForm() {
    const opening = this.getSelectedOpening();
    const line = this.getActiveLine();
    return {
      opening_id: (this.$suggestionOpeningId.val() || "").trim(),
      opening_name: (this.$suggestionOpeningName.val() || "").trim(),
      source_line_id: line ? line.line_id || "" : "",
      source_line_name: line ? line.line_name || "" : "",
      line_name: (this.$suggestionLineName.val() || "").trim(),
      drill_side: normalizeDrillSide(this.$suggestionDrillSide.val()) || this.state.userSide || "",
      start_fen: (this.$suggestionStartFen.val() || "").trim(),
      current_fen: this.chess ? this.chess.fen() : "",
      moves_text: (this.$suggestionMoves.val() || "").trim(),
      notation: "auto",
      comment: (this.$suggestionComment.val() || "").trim(),
      contact: (this.$suggestionContact.val() || "").trim(),
      source_url: window.location.href,
      source_opening_name: opening ? opening.opening_name || "" : ""
    };
  },
  getSuggestionApiBase() {
    let explicit = "";
    try {
      const params = new URLSearchParams(window.location.search);
      explicit = params.get("suggestion_api") || "";
    } catch (error) {
      explicit = "";
    }
    const configured = explicit
      || window.CHESSGYM_SUGGESTION_API_BASE
      || safeLocalStorageGet(SUGGESTION_API_BASE_KEY)
      || "";
    if (configured) {
      return String(configured).replace(/\/+$/, "");
    }
    try {
      return ADMIN_HOSTS.has(window.location.hostname) ? ADMIN_API_BASE : PUBLIC_SUGGESTION_API_BASE;
    } catch (error) {
      return PUBLIC_SUGGESTION_API_BASE;
    }
  },
  suggestionHeaders(admin = false) {
    const headers = { "Content-Type": "application/json" };
    const tokenKey = admin ? SUGGESTION_ADMIN_TOKEN_KEY : SUGGESTION_SUBMIT_TOKEN_KEY;
    const token = safeLocalStorageGet(tokenKey);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  },
  fetchSuggestionApi(path, options = {}) {
    const base = this.getSuggestionApiBase();
    if (!base) {
      return Promise.reject(new Error("Suggestion inbox is not configured."));
    }
    const request = {
      ...options,
      headers: {
        ...this.suggestionHeaders(!!options.admin),
        ...(options.headers || {})
      }
    };
    delete request.admin;
    return fetch(`${base}${path}`, request);
  },
  saveSuggestionDraftFromForm() {
    const payload = this.buildSuggestionPayloadFromForm();
    this.saveSuggestionDraft(payload);
    this.$suggestionStatus.text("Draft saved on this device.");
    this.setStatus("Suggestion draft saved.");
  },
  saveSuggestionDraft(payload) {
    const drafts = loadSuggestionDrafts();
    drafts.unshift({
      ...payload,
      id: `draft_${Date.now().toString(36)}`,
      created_at: new Date().toISOString()
    });
    saveSuggestionDrafts(drafts.slice(0, 50));
  },
  submitSuggestion() {
    const payload = this.buildSuggestionPayloadFromForm();
    if (!payload.moves_text && !payload.comment) {
      this.$suggestionStatus.text("Add moves or a comment before submitting.");
      return;
    }
    this.$suggestionSubmit.prop("disabled", true);
    this.$suggestionStatus.text("Submitting...");
    this.fetchSuggestionApi("/suggestions", {
      method: "POST",
      body: JSON.stringify(payload)
    })
      .then((res) => res.json().then((body) => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status >= 400 || !body.ok) {
          throw new Error(body.error || `HTTP ${status}`);
        }
        this.$suggestionStatus.text("Suggestion submitted.");
        this.setStatus("Suggestion submitted.");
        if (isAdminMode()) {
          this.adminLoadSuggestions();
        }
      })
      .catch((error) => {
        this.saveSuggestionDraft(payload);
        this.$suggestionStatus.text(`${error.message} Saved as a local draft.`);
        this.setStatus("Suggestion saved as draft.");
      })
      .finally(() => {
        this.$suggestionSubmit.prop("disabled", false);
      });
  },
  syncNewLineIdFromName() {
    if (this.$newLineId.data("manual")) {
      return;
    }
    const current = this.$newLineId.val();
    if (current && current !== slugifyId(this.$newLineName.data("lastSlug") || "")) {
      this.$newLineId.data("manual", true);
      return;
    }
    const nextSlug = slugifyId(this.$newLineName.val());
    this.$newLineName.data("lastSlug", nextSlug);
    this.$newLineId.val(nextSlug);
  },
  syncOpeningIdFromName() {
    const typedName = (this.$newLineOpeningName.val() || "").trim();
    const matched = (this.data.openings || []).find(
      (op) => (op.opening_name || "").toLowerCase() === typedName.toLowerCase()
    );
    if (matched) {
      this.$newLineOpeningId.val(matched.opening_id).removeData("manual");
      this.$newLineOpeningName.data("lastSlug", slugifyId(typedName));
      return;
    }
    if (this.$newLineOpeningId.data("manual")) {
      return;
    }
    const previousSlug = slugifyId(this.$newLineOpeningName.data("lastSlug") || "");
    const current = this.$newLineOpeningId.val();
    if (current && current !== previousSlug) {
      this.$newLineOpeningId.data("manual", true);
      return;
    }
    const nextSlug = slugifyId(typedName);
    this.$newLineOpeningName.data("lastSlug", typedName);
    this.$newLineOpeningId.val(nextSlug);
  },
  populateOpeningNameDatalist() {
    if (!this.$newLineOpeningNameList || !this.$newLineOpeningNameList.length) {
      return;
    }
    const seen = new Set();
    const options = (this.data.openings || [])
      .slice()
      .sort((a, b) => (a.opening_name || a.opening_id || "").localeCompare(b.opening_name || b.opening_id || ""))
      .filter((op) => {
        const name = (op.opening_name || "").trim();
        if (!name || seen.has(name.toLowerCase())) return false;
        seen.add(name.toLowerCase());
        return true;
      })
      .map((op) => `<option value="${escapeHtml(op.opening_name)}"></option>`)
      .join("");
    this.$newLineOpeningNameList.html(options);
  },
  generateNewLineRows() {
    try {
      const payload = this.buildNewLinePayload();
      const output = this.formatNewLinePreview(payload);
      this.$newLineOutput.text(output);
      this.setStatus("New line rows generated.");
      return payload;
    } catch (error) {
      this.$newLineOutput.text(error.message || String(error));
      this.setStatus("New line generation failed.");
      return null;
    }
  },
  copyNewLineRows() {
    const payload = this.generateNewLineRows();
    if (!payload) {
      return;
    }
    const output = this.formatNewLinePreview(payload);
    this.copyTextToClipboard(output)
      .then(() => {
        this.setStatus("New line rows copied.");
      })
      .catch(() => {
        this.setStatus("Unable to copy new line rows.");
      });
  },
  copyNewLineAiPrompt() {
    let payload;
    try {
      payload = this.buildNewLinePayload();
    } catch (error) {
      this.$newLineOutput.text(error.message || String(error));
      this.setStatus("AI prompt generation failed.");
      return;
    }
    const prompt = this.buildAiPromptText({
      openingName: payload.opening.row.opening_name || payload.opening.row.opening_id,
      lineName: payload.line.line_name || payload.line.line_id,
      practiceSide: payload.line.drill_side,
      sanNotation: payload.line.moves_pgn
    });
    this.copyTextToClipboard(prompt)
      .then(() => {
        this.$newLineOutput.text("AI prompt copied to clipboard.");
        this.setStatus("AI prompt copied.");
      })
      .catch(() => {
        this.$newLineOutput.text("Unable to copy AI prompt.");
        this.setStatus("Unable to copy AI prompt.");
      });
  },
  submitNewLineWrite() {
    const payload = this.generateNewLineRows();
    if (!payload) {
      return;
    }
    if (!isAdminMode()) {
      this.$newLineOutput.text(`${this.$newLineOutput.text()}\n\nLocal admin mode is required. Start python scripts/admin_server.py and open http://localhost:8787/?admin=1.`);
      return;
    }
    this.submitNewLineToAdmin(payload);
  },
  submitNewLineToAdmin(payload) {
    const adminPayload = {
      line: payload.line,
      opening: payload.opening.row,
      create_opening: !!payload.opening.create,
      moves: payload.nodes.map((n) => n.move_uci).join(" "),
      notation: "uci"
    };
    this.setStatus("Writing line via local sidecar…");
    fetch(`${ADMIN_API_BASE}/line`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adminPayload)
    })
      .then((res) => res.json().then((body) => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status >= 400 || !body.ok) {
          throw new Error(body.error || `HTTP ${status}`);
        }
        const result = body.result || {};
        this.$newLineOutput.text(
          `${this.$newLineOutput.text()}\n\nWritten via sidecar.\n` +
          `line_id: ${result.line_id}\nnodes: ${result.nodes_written}\nthumbnail: ${result.thumbnail}\n\n` +
          `Loaded the new line in the selector.`
        );
        this.setStatus(`Wrote line ${result.line_id}.`);
        this.adminReloadDataAfterStructureChange({
          openingId: result.opening_id || payload.line.opening_id,
          lineId: result.line_id || payload.line.line_id,
          mode: this.state.mode
        }).catch((error) => {
          this.$newLineOutput.text(`${this.$newLineOutput.text()}\n\nReload failed: ${error.message}`);
        });
      })
      .catch((error) => {
        this.$newLineOutput.text(`${this.$newLineOutput.text()}\n\nSidecar write failed: ${error.message}`);
        this.setStatus("Sidecar write failed.");
      });
  },
  setupAdminMode() {
    if (!isAdminMode()) {
      $("#adminPanel").remove();
      return;
    }
    document.body.classList.add("admin-mode");
    this.$adminPanel = $("#adminPanel");
    this.$adminToggle = $("#adminToggle");
    this.$adminBody = $("#adminBody");
    this.$adminLineId = $("#adminLineId");
    this.$adminOpeningId = $("#adminOpeningId");
    this.$adminOpeningName = $("#adminOpeningName");
    this.$adminOpeningDescription = $("#adminOpeningDescription");
    this.$adminOpeningTags = $("#adminOpeningTags");
    this.$adminLineName = $("#adminLineName");
    this.$adminLineDrillSide = $("#adminLineDrillSide");
    this.$adminLineGroup = $("#adminLineGroup");
    this.$adminLineTags = $("#adminLineTags");
    this.$adminLineStartFen = $("#adminLineStartFen");
    this.$adminNodes = $("#adminNodes");
    this.$adminNodesMeta = $("#adminNodesMeta");
    this.$adminStatus = $("#adminStatus");
    this.$adminCommitMsg = $("#adminCommitMsg");
    this.$adminPickerSearch = $("#adminPickerSearch");
    this.$adminPickerList = $("#adminPickerList");
    this.$adminSuggestionMeta = $("#adminSuggestionMeta");
    this.$adminSuggestionList = $("#adminSuggestionList");
    this.$adminSuggestionRefresh = $("#adminSuggestionRefresh");
    this.$adminSaveDirty = $("#adminSaveDirty");
    this.$adminTargetOpeningId = $("#adminTargetOpeningId");
    this.$adminOpeningIdList = $("#adminOpeningIdList");
    this.$adminDuplicateOpenings = $("#adminDuplicateOpenings");
    this.adminDirtyNodes = new Set();
    this.adminSanByNodeId = {};
    this.adminPlyByNodeId = {};
    this.$adminPanel.removeClass("hidden");
    this.$adminNewLineToggle.on("click", () => this.openNewLineModal());
    this.$adminToggle.on("click", () => {
      const collapsed = this.$adminPanel.toggleClass("collapsed").hasClass("collapsed");
      this.$adminToggle.attr("aria-expanded", String(!collapsed));
    });
    this.$adminPickerSearch.on("input", () => this.adminFilterPicker(this.$adminPickerSearch.val()));
    $("#adminSaveOpening").on("click", () => this.adminSaveOpening());
    $("#adminSaveLine").on("click", () => this.adminSaveLine());
    $("#adminMoveLineOpening").on("click", () => this.adminMoveLineToOpening());
    $("#adminMergeOpening").on("click", () => this.adminMergeOpening());
    $("#adminThumbSave").on("click", () => this.adminSaveThumb());
    $("#adminOpeningThumbSave").on("click", () => this.adminSaveOpeningThumb());
    this.$adminSaveDirty.on("click", () => this.adminSaveAllDirty());
    $("#adminBatchApply").on("click", () => this.adminBatchApplyPrompts(false));
    $("#adminBatchSaveAll").on("click", () => this.adminBatchApplyPrompts(true));
    $("#adminBatchClear").on("click", () => $("#adminBatchPromptText").val(""));
    $("#adminAiPrompt").on("click", () => this.copyAdminLineAiPrompt());
    $("#adminCommit").on("click", () => this.adminCommit());
    $("#adminReload").on("click", () => window.location.reload());
    this.$adminSuggestionRefresh.on("click", () => this.adminLoadSuggestions());
    this.$adminSuggestionList.on("click", "button[data-suggestion-action]", (event) => {
      const $button = $(event.currentTarget);
      this.handleSuggestionInboxAction($button.attr("data-suggestion-action"), $button.attr("data-suggestion-id"));
    });
    this.$adminDuplicateOpenings.on("click", "button[data-opening-id]", (event) => {
      this.$adminTargetOpeningId.val($(event.currentTarget).attr("data-opening-id") || "");
    });
    this.adminPopulatePicker();
    this.adminPopulateOpeningTargets();
    this.adminLoadSuggestions();
  },
  adminPopulatePicker() {
    if (!this.$adminPickerList || !this.$adminPickerList.length) return;
    const lines = (this.data.lines || []).slice().sort((a, b) => {
      const aPinned = this.isLinePinned(a.line_id) ? 0 : 1;
      const bPinned = this.isLinePinned(b.line_id) ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;
      const oa = (a.opening_id || "").localeCompare(b.opening_id || "");
      if (oa !== 0) return oa;
      return (a.line_name || a.line_id || "").localeCompare(b.line_name || b.line_id || "");
    });
    this.$adminPickerList.empty();
    let lastOpening = null;
    let lastWasPinnedGroup = false;
    lines.forEach((line) => {
      const pinned = this.isLinePinned(line.line_id);
      const groupKey = pinned ? "__pinned__" : line.opening_id;
      if (groupKey !== lastOpening) {
        let label;
        if (pinned) {
          label = "★ Pinned";
          lastWasPinnedGroup = true;
        } else {
          const opening = this.data.openingsById[line.opening_id];
          label = opening ? (opening.opening_name || opening.opening_id) : line.opening_id;
          lastWasPinnedGroup = false;
        }
        this.$adminPickerList.append(`<div class="admin-picker-group">${escapeHtml(label)}</div>`);
        lastOpening = groupKey;
      }
      const nodeCount = (this.data.nodesByLineId[line.line_id] || []).length;
      const $btn = $(
        `<button type="button" class="admin-picker-item" data-line-id="${line.line_id}" data-opening-id="${line.opening_id}" data-tags="${escapeHtml(line.tags || "")}">
          <span class="admin-pin-toggle" role="button" aria-label="${pinned ? "Unpin" : "Pin"} line" title="${pinned ? "Unpin" : "Pin"} line">${pinned ? "★" : "☆"}</span>
          <span class="admin-picker-name"></span>
          <span class="admin-picker-meta">${nodeCount} · ${line.drill_side || "?"}</span>
        </button>`
      );
      if (pinned) {
        $btn.find(".admin-pin-toggle").addClass("is-pinned");
      }
      $btn.find(".admin-picker-name").text(line.line_name || line.line_id);
      $btn.find(".admin-pin-toggle").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.togglePinnedLine(line.line_id);
      });
      $btn.on("click", () => this.adminSelectLineFromPicker(line.opening_id, line.line_id));
      this.$adminPickerList.append($btn);
    });
    this.adminMarkActivePickerItem();
  },
  adminFilterPicker(query) {
    const q = (query || "").toLowerCase().trim();
    let visibleSinceGroup = false;
    let $currentGroup = null;
    this.$adminPickerList.children().each((_, el) => {
      const $el = $(el);
      if ($el.hasClass("admin-picker-group")) {
        if ($currentGroup) $currentGroup.toggle(visibleSinceGroup);
        $currentGroup = $el;
        visibleSinceGroup = false;
      } else {
        const openingId = $el.attr("data-opening-id") || "";
        const openingName = this.lookupOpeningName(openingId) || "";
        const text = ($el.text() + " " + $el.attr("data-line-id") + " " + openingId + " " + openingName + " " + ($el.attr("data-tags") || "")).toLowerCase();
        const match = !q || text.includes(q);
        $el.toggle(match);
        if (match) visibleSinceGroup = true;
      }
    });
    if ($currentGroup) $currentGroup.toggle(visibleSinceGroup);
  },
  adminMarkActivePickerItem() {
    if (!this.$adminPickerList || !this.$adminPickerList.length) return;
    const lineId = this.state.lineId;
    this.$adminPickerList.find(".admin-picker-item").each((_, el) => {
      const $el = $(el);
      $el.toggleClass("active", $el.attr("data-line-id") === lineId);
    });
  },
  adminPopulateOpeningTargets() {
    if (!this.$adminOpeningIdList || !this.$adminOpeningIdList.length) return;
    const options = (this.data.openings || [])
      .slice()
      .sort((a, b) => {
        const aName = (a.opening_name || a.opening_id || "").toString();
        const bName = (b.opening_name || b.opening_id || "").toString();
        return aName.localeCompare(bName, undefined, { sensitivity: "base" });
      })
      .map((opening) => {
        const id = opening.opening_id || "";
        const name = opening.opening_name || "";
        return `<option value="${escapeHtml(id)}" label="${escapeHtml(name)}"></option>`;
      })
      .join("");
    this.$adminOpeningIdList.html(options);
  },
  adminLoadSuggestions() {
    if (!this.$adminSuggestionList || !this.$adminSuggestionList.length) {
      return;
    }
    this.$adminSuggestionMeta.text("loading");
    this.fetchSuggestionApi("/suggestions", { method: "GET", admin: true })
      .then((res) => res.json().then((body) => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status >= 400 || !body.ok) {
          throw new Error(body.error || `HTTP ${status}`);
        }
        this.renderSuggestionInbox(body.suggestions || []);
      })
      .catch((error) => {
        this.$adminSuggestionMeta.text("unavailable");
        this.$adminSuggestionList.empty().append($("<p>").addClass("admin-help").text(error.message));
      });
  },
  renderSuggestionInbox(suggestions) {
    this.adminSuggestionsById = {};
    const visible = (suggestions || []).filter((item) => (item.status || "pending") !== "archived");
    visible.forEach((item) => {
      if (item.id) {
        this.adminSuggestionsById[item.id] = item;
      }
    });
    const pendingCount = visible.filter((item) => (item.status || "pending") === "pending").length;
    this.$adminSuggestionMeta.text(`${pendingCount} pending`);
    this.$adminSuggestionList.empty();
    if (!visible.length) {
      this.$adminSuggestionList.append($("<p>").addClass("admin-help").text("No active suggestions."));
      return;
    }
    visible.forEach((suggestion) => {
      const title = suggestion.line_name || suggestion.source_line_name || "Suggested line";
      const opening = suggestion.opening_name || suggestion.opening_id || "Unknown opening";
      const status = suggestion.status || "pending";
      const created = suggestion.created_at ? new Date(suggestion.created_at).toLocaleString() : "";
      const moves = compactText(suggestion.moves_text || "", 220);
      const comment = compactText(suggestion.comment || "", 220);
      const contact = suggestion.contact || "";
      const $item = $("<article>").addClass("admin-suggestion-item").toggleClass("is-done", status === "done");
      const $header = $("<div>").addClass("admin-suggestion-header");
      $header.append($("<strong>").text(title));
      $header.append($("<span>").addClass("admin-suggestion-status").text(status));
      $item.append($header);
      $item.append($("<div>").addClass("admin-suggestion-meta").text([opening, created, contact].filter(Boolean).join(" · ")));
      if (moves) {
        $item.append($("<pre>").addClass("admin-suggestion-preview").text(moves));
      }
      if (comment) {
        $item.append($("<p>").addClass("admin-suggestion-comment").text(comment));
      }
      const $actions = $("<div>").addClass("admin-actions");
      $actions.append(this.buildSuggestionActionButton(suggestion.id, "use", "Use"));
      if (status === "done") {
        $actions.append(this.buildSuggestionActionButton(suggestion.id, "pending", "Reopen"));
      } else {
        $actions.append(this.buildSuggestionActionButton(suggestion.id, "done", "Done"));
      }
      $actions.append(this.buildSuggestionActionButton(suggestion.id, "archived", "Archive"));
      $item.append($actions);
      this.$adminSuggestionList.append($item);
    });
  },
  buildSuggestionActionButton(id, action, label) {
    return $("<button>")
      .attr("type", "button")
      .attr("data-suggestion-id", id || "")
      .attr("data-suggestion-action", action)
      .addClass("ghost")
      .text(label);
  },
  handleSuggestionInboxAction(action, suggestionId) {
    const suggestion = this.adminSuggestionsById && this.adminSuggestionsById[suggestionId];
    if (!suggestion) {
      this.adminStatus("Suggestion not found.", true);
      return;
    }
    if (action === "use") {
      this.populateNewLineFromSuggestion(suggestion);
      return;
    }
    if (action === "done" || action === "pending" || action === "archived") {
      this.updateSuggestionStatus(suggestionId, action);
    }
  },
  populateNewLineFromSuggestion(suggestion) {
    if (!isAdminMode()) {
      return;
    }
    if (this.$adminPanel && this.$adminPanel.hasClass("collapsed")) {
      this.$adminPanel.removeClass("collapsed");
      this.$adminToggle.attr("aria-expanded", "true");
    }
    this.openNewLineModal();
    const openingId = suggestion.opening_id || this.state.openingId || "";
    const openingName = suggestion.opening_name || (this.data.openingsById[openingId] && this.data.openingsById[openingId].opening_name) || openingId;
    const lineName = suggestion.line_name || suggestion.source_line_name || "Suggested line";
    const suggestedId = suggestion.line_id || slugifyId(lineName);
    this.$newLineOpeningId.val(openingId).data("manual", true);
    this.$newLineOpeningName.val(openingName).data("lastSlug", slugifyId(openingName));
    this.$newLineName.val(lineName).removeData("lastSlug");
    this.$newLineId.val(this.uniqueLineId(suggestedId || lineName)).data("manual", true);
    this.$newLineDrillSide.val(normalizeDrillSide(suggestion.drill_side) || this.state.userSide || "white");
    this.$newLineNotation.val("auto");
    this.$newLineTags.val("suggested");
    this.$newLineStartFen.val(suggestion.start_fen || "");
    this.$newLineMoves.val(suggestion.moves_text || "");
    this.$newLineCreateOpening.prop("checked", !!(openingId && !this.data.openingsById[openingId]));
    const details = [
      "Loaded suggestion into the new-line form.",
      suggestion.comment ? `Comment: ${suggestion.comment}` : "",
      suggestion.contact ? `Contact: ${suggestion.contact}` : "",
      suggestion.current_fen ? `Current FEN: ${suggestion.current_fen}` : "",
      suggestion.id ? `Suggestion ID: ${suggestion.id}` : ""
    ].filter(Boolean).join("\n");
    this.$newLineOutput.text(details);
    this.adminStatus("Suggestion loaded into New Line.");
  },
  uniqueLineId(value) {
    const base = slugifyId(value) || `suggested_line_${Date.now().toString(36)}`;
    let candidate = base;
    let index = 2;
    while (this.data.linesById[candidate]) {
      candidate = `${base}_${index}`;
      index += 1;
    }
    return candidate;
  },
  updateSuggestionStatus(suggestionId, status) {
    this.adminStatus(`Updating suggestion…`);
    this.fetchSuggestionApi(`/suggestions/${encodeURIComponent(suggestionId)}`, {
      method: "PATCH",
      admin: true,
      body: JSON.stringify({ status })
    })
      .then((res) => res.json().then((body) => ({ status: res.status, body })))
      .then(({ status: httpStatus, body }) => {
        if (httpStatus >= 400 || !body.ok) {
          throw new Error(body.error || `HTTP ${httpStatus}`);
        }
        this.adminStatus("Suggestion updated.");
        this.adminLoadSuggestions();
      })
      .catch((error) => this.adminStatus(`Suggestion update failed: ${error.message}`, true));
  },
  adminUpdateOpeningTools(line, opening) {
    if (!this.$adminTargetOpeningId || !this.$adminTargetOpeningId.length) return;
    const sourceId = (opening && opening.opening_id) || (line && line.opening_id) || this.state.openingId || "";
    const previousSourceId = this.$adminTargetOpeningId.data("sourceOpeningId") || "";
    if (previousSourceId !== sourceId) {
      this.$adminTargetOpeningId.val("");
      this.$adminTargetOpeningId.data("sourceOpeningId", sourceId);
    }
    this.$adminTargetOpeningId.attr("placeholder", sourceId ? `Target opening ID (not ${sourceId})` : "opening_id");

    if (!this.$adminDuplicateOpenings || !this.$adminDuplicateOpenings.length) return;
    this.$adminDuplicateOpenings.empty().addClass("hidden");
    const key = normalizeOpeningNameKey(opening && opening.opening_name);
    if (!key) return;
    const duplicates = (this.data.openings || []).filter((candidate) =>
      candidate.opening_id !== sourceId && normalizeOpeningNameKey(candidate.opening_name) === key
    );
    if (!duplicates.length) return;

    this.$adminDuplicateOpenings.removeClass("hidden");
    this.$adminDuplicateOpenings.append($("<span>").text("Same name:"));
    duplicates.forEach((candidate) => {
      const lineCount = (this.data.linesByOpeningId[candidate.opening_id] || []).length;
      const label = `${candidate.opening_id}${lineCount ? ` (${lineCount})` : ""}`;
      const $button = $("<button>")
        .attr("type", "button")
        .attr("data-opening-id", candidate.opening_id)
        .addClass("admin-target-chip")
        .text(label);
      this.$adminDuplicateOpenings.append($button);
    });
  },
  adminGetTargetOpeningId() {
    const raw = String(this.$adminTargetOpeningId.val() || "").trim();
    if (!raw) {
      this.adminStatus("Choose a target opening first.", true);
      return "";
    }
    let targetId = raw;
    if (!this.data.openingsById[targetId]) {
      const matches = (this.data.openings || []).filter((opening) =>
        (opening.opening_name || "").toLowerCase() === raw.toLowerCase()
      );
      if (matches.length === 1) {
        targetId = matches[0].opening_id;
      } else if (matches.length > 1) {
        this.adminStatus(`Multiple openings are named "${raw}". Use the opening_id.`, true);
        return "";
      }
    }
    if (!this.data.openingsById[targetId]) {
      this.adminStatus(`Target opening not found: ${targetId}`, true);
      return "";
    }
    return targetId;
  },
  adminConfirmDiscardDirtyNodes(actionLabel) {
    if (!this.adminDirtyNodes || this.adminDirtyNodes.size === 0) {
      return true;
    }
    return window.confirm(`${this.adminDirtyNodes.size} unsaved node edit(s) will be discarded before ${actionLabel}. Continue?`);
  },
  adminSelectLineFromPicker(openingId, lineId) {
    if (this.adminDirtyNodes && this.adminDirtyNodes.size > 0) {
      if (!window.confirm(`${this.adminDirtyNodes.size} unsaved node edit(s) will be discarded. Continue?`)) {
        return;
      }
    }
    if (this.state.openingId !== openingId) {
      this.onOpeningChange(openingId);
    }
    this.onLineChange(lineId);
  },
  computeSanForLine(line) {
    const sanByNodeId = {};
    const plyByNodeId = {};
    if (!line) return { sanByNodeId, plyByNodeId, total: 0 };
    const nodes = (this.data.nodesByLineId[line.line_id] || []).slice().sort((a, b) =>
      (a.node_id || "").localeCompare(b.node_id || "")
    );
    let chess;
    try {
      chess = (line.start_fen || "").trim() ? new Chess(line.start_fen.trim()) : new Chess();
    } catch (e) {
      chess = new Chess();
    }
    let ply = 0;
    nodes.forEach((node) => {
      const move = applyMoveUCI(chess, node.move_uci);
      if (move) {
        ply += 1;
        sanByNodeId[node.node_id] = move.san;
        plyByNodeId[node.node_id] = ply;
      }
    });
    return { sanByNodeId, plyByNodeId, total: ply };
  },
  refreshAdminPanel() {
    if (!isAdminMode() || !this.$adminPanel || !this.$adminPanel.length) {
      return;
    }
    const line = this.getActiveLine();
    if (this.$adminPickerList && !this.$adminPickerList.children().length && this.data.lines.length) {
      this.adminPopulatePicker();
    }
    this.adminPopulateOpeningTargets();
    this.adminMarkActivePickerItem();
    if (!line) {
      this.$adminBody.addClass("empty");
      this.$adminLineId.text("(no line selected)");
      this.$adminNodes.empty();
      this.$adminNodesMeta.text("");
      this.adminUpdateOpeningTools(null, this.getSelectedOpening());
      return;
    }
    this.$adminBody.removeClass("empty");
    this.$adminLineId.text(line.line_id).attr("title", line.line_id);
    const opening = this.data.openingsById[line.opening_id] || {};
    this.$adminOpeningId.text(opening.opening_id || line.opening_id || "");
    this.$adminOpeningName.val(opening.opening_name || "");
    this.$adminOpeningDescription.val(opening.description || "");
    this.$adminOpeningTags.val(opening.tags || "");
    this.adminUpdateOpeningTools(line, opening);
    this.$adminLineName.val(line.line_name || "");
    this.$adminLineDrillSide.val(line.drill_side || "white");
    this.$adminLineGroup.val(line.line_group || "");
    if (this.$adminLineTags && this.$adminLineTags.length) {
      this.$adminLineTags.val(line.tags || "");
    }
    this.$adminLineStartFen.val(line.start_fen || "");

    const { sanByNodeId, plyByNodeId, total } = this.computeSanForLine(line);
    this.adminSanByNodeId = sanByNodeId;
    this.adminPlyByNodeId = plyByNodeId;

    this.adminDirtyNodes = new Set();
    this.$adminSaveDirty.prop("disabled", true);
    this.$adminNodesMeta.text(`${total} ply`);

    const nodes = (this.data.nodesByLineId[line.line_id] || []).slice().sort((a, b) =>
      (a.node_id || "").localeCompare(b.node_id || "")
    );
    this.$adminNodes.empty();
    nodes.forEach((node) => {
      const san = sanByNodeId[node.node_id] || "";
      const ply = plyByNodeId[node.node_id] || 0;
      const $row = $(
        `<div class="admin-node" data-node-id="${node.node_id}" data-ply="${ply}">
          <div class="admin-node-head">
            <span class="admin-node-id">${node.node_id}</span>
            <span class="admin-node-san"></span>
            <span class="admin-node-uci">${node.move_uci || ""}</span>
          </div>
          <label>learn_prompt
            <textarea data-field="learn_prompt" rows="2"></textarea>
          </label>
          <div class="admin-node-extra">
            <label>mistake_map
              <input data-field="mistake_map" type="text" />
            </label>
          </div>
          <div class="admin-node-actions">
            <button type="button" class="ghost admin-toggle-extra" title="Show mistake_map">…</button>
            <button type="button" class="ghost admin-save-node">Save</button>
          </div>
        </div>`
      );
      $row.find(".admin-node-san").text(san);
      $row.find('[data-field="learn_prompt"]').val(node.learn_prompt || "");
      $row.find('[data-field="mistake_map"]').val(node.mistake_map || "");
      const markDirty = () => {
        if (!$row.hasClass("dirty")) {
          $row.addClass("dirty");
          this.adminDirtyNodes.add(node.node_id);
          this.$adminSaveDirty.prop("disabled", this.adminDirtyNodes.size === 0);
        }
      };
      $row.find('[data-field]').on("input", markDirty);
      $row.find(".admin-toggle-extra").on("click", (event) => {
        event.stopPropagation();
        $row.toggleClass("expanded");
      });
      $row.find(".admin-save-node").on("click", (event) => {
        event.stopPropagation();
        this.adminSaveNode(node.node_id, $row);
      });
      $row.find('[data-field], button').on("click", (event) => event.stopPropagation());
      $row.on("click", () => this.adminGoToPly(ply));
      this.$adminNodes.append($row);
    });
  },
  adminHighlightActiveNode() {
    const ply = (this.state.moveHistory || []).length;
    if (!this.$adminNodes) return;
    this.$adminNodes.find(".admin-node").each((_, el) => {
      const $el = $(el);
      $el.toggleClass("active", parseInt($el.attr("data-ply"), 10) === ply);
    });
  },
  adminGoToPly(targetPly) {
    if (!Number.isFinite(targetPly) || targetPly < 0) return;
    const current = (this.state.moveHistory || []).length;
    let diff = targetPly - current;
    let safety = Math.abs(diff) + 8;
    while (diff !== 0 && safety-- > 0) {
      const before = (this.state.moveHistory || []).length;
      this.stepMove(diff > 0 ? 1 : -1);
      const after = (this.state.moveHistory || []).length;
      if (after === before) break;
      diff = targetPly - after;
    }
    this.adminHighlightActiveNode();
  },
  currentBoardFen() {
    if (this.chess && typeof this.chess.fen === "function") {
      return this.chess.fen();
    }
    return "";
  },
  currentBoardFlip() {
    if (this.board && typeof this.board.orientation === "function") {
      return this.board.orientation() === "black";
    }
    return this.state.userSide === "black";
  },
  adminSaveThumb() {
    const line = this.getActiveLine();
    if (!line) return;
    const fen = this.currentBoardFen();
    if (!fen) {
      this.adminStatus("No board position available.", true);
      return;
    }
    this.adminStatus(`Rendering line thumbnail from current board…`);
    this.adminFetch(`/thumbnail/${encodeURIComponent(line.line_id)}`, {
      method: "POST",
      body: JSON.stringify({ fen, flip: this.currentBoardFlip() })
    })
      .then((body) => {
        this.bumpThumbnailVersion(line.line_id);
        this.updateSelectorThumbnails();
        this.adminStatus(`Wrote ${body.result.thumbnail}.`);
      })
      .catch((error) => this.adminStatus(`Thumbnail failed: ${error.message}`, true));
  },
  adminSaveOpeningThumb() {
    const opening = this.getSelectedOpening();
    if (!opening) {
      this.adminStatus("Select an opening before rendering its thumbnail.", true);
      return;
    }
    const fen = this.currentBoardFen();
    if (!fen) {
      this.adminStatus("No board position available.", true);
      return;
    }
    this.adminStatus(`Rendering opening thumbnail ${opening.opening_id} from current board…`);
    this.adminFetch(`/opening-thumbnail/${encodeURIComponent(opening.opening_id)}`, {
      method: "POST",
      body: JSON.stringify({ fen, flip: this.currentBoardFlip() })
    })
      .then((body) => {
        this.bumpThumbnailVersion(opening.opening_id);
        this.updateSelectorThumbnails();
        this.adminStatus(`Wrote ${body.result.thumbnail}.`);
      })
      .catch((error) => this.adminStatus(`Opening thumbnail failed: ${error.message}`, true));
  },
  adminFetch(path, options) {
    return fetch(`${ADMIN_API_BASE}${path}`, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {}))
      .then((res) => res.json().then((body) => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status >= 400 || (body && body.ok === false)) {
          throw new Error((body && body.error) || `HTTP ${status}`);
        }
        this.reportFenWarnings(body && body.fen_warnings);
        return body;
      });
  },
  reportFenWarnings(warnings) {
    if (!Array.isArray(warnings) || !warnings.length) {
      return;
    }
    const preview = warnings.slice(0, 3).join(" | ");
    const suffix = warnings.length > 3 ? ` (+${warnings.length - 3} more, see sidecar log)` : "";
    this.adminStatus(`FEN warning: ${preview}${suffix}`, true);
  },
  adminStatus(message, isError) {
    if (!this.$adminStatus) return;
    this.$adminStatus.text(message || "").toggleClass("error", !!isError);
  },
  adminSaveNode(nodeId, $row) {
    const fields = {
      learn_prompt: $row.find('[data-field="learn_prompt"]').val(),
      mistake_map: $row.find('[data-field="mistake_map"]').val()
    };
    this.adminStatus(`Saving ${nodeId}…`);
    return this.adminFetch(`/node/${encodeURIComponent(nodeId)}`, {
      method: "PATCH",
      body: JSON.stringify(fields)
    })
      .then((body) => {
        const node = this.data.nodesById[nodeId];
        if (node) {
          node.learn_prompt = body.node.learn_prompt;
          node.mistake_map = body.node.mistake_map;
        }
        $row.removeClass("dirty");
        this.adminDirtyNodes.delete(nodeId);
        this.$adminSaveDirty.prop("disabled", this.adminDirtyNodes.size === 0);
        this.adminStatus(`Saved ${nodeId}.`);
        this.renderCoachComment();
      })
      .catch((error) => {
        this.adminStatus(`Save failed: ${error.message}`, true);
        throw error;
      });
  },
  adminBatchApplyPrompts(saveAfter) {
    if (!this.$adminNodes || !this.$adminNodes.length) return;
    const text = $("#adminBatchPromptText").val() || "";
    const lines = text.split(/\r?\n/);
    const $rows = this.$adminNodes.find(".admin-node");
    let applied = 0;
    let skipped = 0;
    let consumed = 0;
    $rows.each((_, el) => {
      if (consumed >= lines.length) return false;
      const raw = lines[consumed];
      consumed += 1;
      if (raw.trim() === "") {
        skipped += 1;
        return true;
      }
      const $row = $(el);
      const $field = $row.find('[data-field="learn_prompt"]');
      if ($field.val() !== raw) {
        $field.val(raw).trigger("input");
        applied += 1;
      }
    });
    const overflow = Math.max(0, lines.length - $rows.length);
    const overflowMsg = overflow ? `, ${overflow} extra line(s) ignored` : "";
    this.adminStatus(`Applied ${applied} prompt(s), skipped ${skipped}${overflowMsg}.`);
    if (saveAfter && this.adminDirtyNodes && this.adminDirtyNodes.size > 0) {
      this.adminSaveAllDirty();
    }
  },
  adminSaveAllDirty() {
    if (!this.adminDirtyNodes || this.adminDirtyNodes.size === 0) return;
    const ids = Array.from(this.adminDirtyNodes);
    this.adminStatus(`Saving ${ids.length} node(s)…`);
    let ok = 0;
    let fail = 0;
    const next = (i) => {
      if (i >= ids.length) {
        this.adminStatus(`Saved ${ok}, failed ${fail}.`, fail > 0);
        return;
      }
      const id = ids[i];
      const $row = this.$adminNodes.find(`[data-node-id="${id}"]`);
      this.adminSaveNode(id, $row).then(
        () => { ok += 1; next(i + 1); },
        () => { fail += 1; next(i + 1); }
      );
    };
    next(0);
  },
  copyAdminLineAiPrompt() {
    const line = this.getActiveLine();
    if (!line) {
      this.adminStatus("Select a line before copying an AI prompt.", true);
      return;
    }
    const opening = this.data.openingsById[line.opening_id] || {};
    const sanNotation = this.getSanNotationForLine(line, { startFen: this.$adminLineStartFen.val() }) || line.moves_pgn || "";
    if (!sanNotation.trim()) {
      this.adminStatus(`Unable to build SAN for ${line.line_id}.`, true);
      return;
    }
    const prompt = this.buildAiPromptText({
      openingName: this.$adminOpeningName.val() || opening.opening_name || opening.opening_id || line.opening_id,
      lineName: this.$adminLineName.val() || line.line_name || line.line_id,
      practiceSide: this.$adminLineDrillSide.val() || line.drill_side,
      sanNotation
    });
    this.copyTextToClipboard(prompt)
      .then(() => this.adminStatus(`AI prompt copied for ${line.line_id}.`))
      .catch(() => this.adminStatus("Unable to copy AI prompt.", true));
  },
  buildAiPromptText(details) {
    const rawOpening = String(details.openingName || "").trim();
    const rawLine = String(details.lineName || "").trim();
    const openingName = rawOpening || "(not provided)";
    const lineName = rawLine || "(not provided)";
    const practiceSide = formatSideLabel(details.practiceSide) || "(not provided)";
    const sanNotation = String(details.sanNotation || "").trim();
    const missingNotes = [];
    if (!rawOpening) {
      missingNotes.push("- Opening name is missing. Identify the opening from the SAN and propose a clear, conventional name (e.g. \"Italian Game\", \"Caro-Kann Defense\"). Put your suggestion on a line beginning with `Opening:`.");
    }
    if (!rawLine) {
      missingNotes.push("- Line name is missing. Propose a short, descriptive line name that captures the tactical or strategic theme of the sequence (3-6 words, no punctuation). Put your suggestion on a line beginning with `Line:`.");
    }
    const sections = [
      "You are an expert chess coach specializing in creating high-quality study lines. For each move in the sequence, produce exactly one sentence per half-move in a clean single-column format inside a code block.",
      "",
      `Opening: ${openingName}`,
      `Line: ${lineName}`,
      `Practice side: ${practiceSide}`,
      "",
      "SAN:",
      sanNotation,
      ""
    ];
    if (missingNotes.length) {
      sections.push("Additional task — when fields are missing, fill them in BEFORE the move-by-move code block:");
      sections.push(...missingNotes);
      sections.push("");
    }
    sections.push(AI_PROMPT_STYLE_RULES);
    return sections.join("\n");
  },
  getPreferredLineNodeKeys(line) {
    if (!line || !line.line_id) {
      return [];
    }
    const leafKeys = this.getLeafDescendants(line.line_id);
    if (!leafKeys.length) {
      return [];
    }
    const leafKey = leafKeys.slice().sort((aKey, bKey) => {
      const aNode = this.data.nodesById[aKey];
      const bNode = this.data.nodesById[bKey];
      const aDepth = aNode ? aNode._depth || 0 : 0;
      const bDepth = bNode ? bNode._depth || 0 : 0;
      if (aDepth !== bDepth) {
        return bDepth - aDepth;
      }
      return aKey.localeCompare(bKey);
    })[0];
    return this.buildPathToRoot(leafKey);
  },
  getSanNotationForLine(line, options = {}) {
    const nodeKeys = this.getPreferredLineNodeKeys(line);
    if (!nodeKeys.length) {
      return line && line.moves_pgn ? line.moves_pgn : "";
    }
    const chess = new Chess();
    const startFen = options.startFen !== undefined ? options.startFen : line.start_fen;
    if (!loadFenForChess(chess, startFen || "")) {
      return line.moves_pgn || "";
    }
    const moves = [];
    for (const nodeKey of nodeKeys) {
      const node = this.data.nodesById[nodeKey];
      if (!node) {
        continue;
      }
      const fenParts = chess.fen().split(/\s+/);
      const color = fenParts[1] === "b" ? "black" : "white";
      const moveNumber = parseInt(fenParts[5] || "1", 10) || 1;
      const move = applyMoveUCI(chess, node.move_uci);
      if (!move) {
        return line.moves_pgn || "";
      }
      moves.push({
        san: move.san,
        color,
        moveNumber
      });
    }
    return moves.length ? formatSanMoves(moves) : (line.moves_pgn || "");
  },
  adminSaveOpening() {
    const line = this.getActiveLine();
    if (!line) return;
    const opening = this.data.openingsById[line.opening_id];
    if (!opening) {
      this.adminStatus(`Opening not found: ${line.opening_id}`, true);
      return;
    }
    const fields = {
      opening_name: this.$adminOpeningName.val(),
      description: this.$adminOpeningDescription.val(),
      tags: this.$adminOpeningTags.val()
    };
    this.adminStatus(`Saving opening ${opening.opening_id}…`);
    this.adminFetch(`/opening/${encodeURIComponent(opening.opening_id)}`, {
      method: "PATCH",
      body: JSON.stringify(fields)
    })
      .then((body) => {
        Object.assign(opening, body.opening);
        this.adminStatus(`Saved opening ${opening.opening_id}.`);
        this.buildIndexes();
        this.adminPopulatePicker();
        this.populateSelectors({ openingId: opening.opening_id, lineId: this.state.lineId });
        this.setLineStatus(this.getActiveLine());
        this.refreshAdminPanel();
      })
      .catch((error) => this.adminStatus(`Save failed: ${error.message}`, true));
  },
  adminSaveLine() {
    const line = this.getActiveLine();
    if (!line) return;
    const lineId = line.line_id;
    const openingId = line.opening_id;
    const previousStartFen = line.start_fen || "";
    const previousDrillSide = line.drill_side || "";
    const fields = {
      line_name: this.$adminLineName.val(),
      drill_side: this.$adminLineDrillSide.val(),
      line_group: this.$adminLineGroup.val(),
      tags: (this.$adminLineTags && this.$adminLineTags.length) ? this.$adminLineTags.val() : (line.tags || ""),
      start_fen: this.$adminLineStartFen.val()
    };
    this.adminStatus(`Saving line ${line.line_id}…`);
    this.adminFetch(`/line/${encodeURIComponent(line.line_id)}`, {
      method: "PATCH",
      body: JSON.stringify(fields)
    })
      .then((body) => {
        Object.assign(line, body.line);
        this.buildIndexes();
        this.populateSelectors({ openingId, lineId });
        const startChanged = previousStartFen !== ((body.line && body.line.start_fen) || "");
        const sideChanged = previousDrillSide !== ((body.line && body.line.drill_side) || "");
        if (startChanged || sideChanged) {
          this.prepareSession();
        } else {
          this.setLineStatus(this.getActiveLine());
        }
        this.adminStatus(`Saved line ${lineId}.`);
        this.adminPopulatePicker();
        this.refreshAdminPanel();
      })
      .catch((error) => this.adminStatus(`Save failed: ${error.message}`, true));
  },
  adminReloadDataAfterStructureChange(defaults = {}) {
    const mode = defaults.mode || this.state.mode || this.$mode.val() || "learning";
    return this.fetchDataset()
      .then((dataset) => {
        this.data.openings = dataset.openings || [];
        this.data.lines = dataset.lines || [];
        this.data.nodes = dataset.nodes || [];
        this.data.mistakeTemplates = dataset.mistake_templates || [];
        this.buildIndexes();
        this.state.mode = mode;
        this.$mode.val(mode);
        this.populateSelectors({
          openingId: defaults.openingId || this.state.openingId,
          lineId: defaults.lineId || this.state.lineId
        });
        this.prepareSession();
        this.adminPopulatePicker();
        this.refreshAdminPanel();
      });
  },
  adminMoveLineToOpening() {
    const line = this.getActiveLine();
    if (!line) {
      this.adminStatus("Select a line before moving it.", true);
      return;
    }
    const targetId = this.adminGetTargetOpeningId();
    if (!targetId) return;
    const sourceId = line.opening_id || "";
    if (targetId === sourceId) {
      this.adminStatus("Target opening is already the line's opening.", true);
      return;
    }
    if (!this.adminConfirmDiscardDirtyNodes("moving this line")) return;

    const source = this.data.openingsById[sourceId] || {};
    const target = this.data.openingsById[targetId] || {};
    const lineLabel = line.line_name || line.line_id;
    const sourceLabel = source.opening_name || sourceId;
    const targetLabel = target.opening_name || targetId;
    if (!window.confirm(`Move "${lineLabel}" from "${sourceLabel}" to "${targetLabel}"?`)) {
      return;
    }

    this.adminStatus(`Moving ${line.line_id} to ${targetId}…`);
    this.adminFetch(`/line/${encodeURIComponent(line.line_id)}/move`, {
      method: "POST",
      body: JSON.stringify({
        source_opening_id: sourceId,
        target_opening_id: targetId
      })
    })
      .then((body) => {
        const result = body.result || {};
        const warnings = body.fen_warnings || result.fen_warnings || [];
        return this.adminReloadDataAfterStructureChange({
          openingId: targetId,
          lineId: line.line_id,
          mode: this.state.mode
        }).then(() => {
          const warningText = warnings.length ? ` ${warnings.length} FEN warning(s).` : "";
          this.adminStatus(`Moved ${result.line_id || line.line_id} to ${targetId}.${warningText}`, warnings.length > 0);
        });
      })
      .catch((error) => this.adminStatus(`Move failed: ${error.message}`, true));
  },
  adminMergeOpening() {
    const line = this.getActiveLine();
    const sourceId = (line && line.opening_id) || this.state.openingId || "";
    if (!sourceId) {
      this.adminStatus("Select an opening before merging.", true);
      return;
    }
    const targetId = this.adminGetTargetOpeningId();
    if (!targetId) return;
    if (targetId === sourceId) {
      this.adminStatus("Target opening must be different from the current opening.", true);
      return;
    }
    if (!this.adminConfirmDiscardDirtyNodes("merging this opening")) return;

    const source = this.data.openingsById[sourceId] || {};
    const target = this.data.openingsById[targetId] || {};
    const sourceLabel = source.opening_name || sourceId;
    const targetLabel = target.opening_name || targetId;
    const sourceLineCount = (this.data.linesByOpeningId[sourceId] || []).length;
    const selectedLineId = line ? line.line_id : "";
    const message = `Merge "${sourceLabel}" (${sourceId}) into "${targetLabel}" (${targetId})?\n\n` +
      `This moves ${sourceLineCount} line(s), updates their nodes, and removes the source opening row.`;
    if (!window.confirm(message)) {
      return;
    }

    this.adminStatus(`Merging ${sourceId} into ${targetId}…`);
    this.adminFetch(`/opening/${encodeURIComponent(sourceId)}/merge`, {
      method: "POST",
      body: JSON.stringify({
        target_opening_id: targetId,
        merge_metadata: true
      })
    })
      .then((body) => {
        const result = body.result || {};
        const warnings = body.fen_warnings || result.fen_warnings || [];
        return this.adminReloadDataAfterStructureChange({
          openingId: targetId,
          lineId: selectedLineId,
          mode: this.state.mode
        }).then(() => {
          const warningText = warnings.length ? ` ${warnings.length} FEN warning(s).` : "";
          this.adminStatus(`Merged ${result.source_opening_id || sourceId} into ${targetId}; moved ${result.lines_moved || 0} line(s).${warningText}`, warnings.length > 0);
        });
      })
      .catch((error) => this.adminStatus(`Merge failed: ${error.message}`, true));
  },
  adminCommit() {
    const message = (this.$adminCommitMsg.val() || "").trim();
    this.adminStatus("Committing…");
    this.adminFetch(`/git/commit`, { method: "POST", body: JSON.stringify({ message }) })
      .then((body) => {
        const last = (body.result.steps || []).slice(-1)[0] || {};
        const ok = (body.result.steps || []).every((step) => step.code === 0 || /nothing to commit/i.test(step.stdout + step.stderr));
        this.adminStatus(ok ? `Committed: ${last.stdout || "ok"}` : `Commit issue: ${last.stderr || last.stdout}`, !ok);
      })
      .catch((error) => this.adminStatus(`Commit failed: ${error.message}`, true));
  },
  buildNewLinePayload() {
    const openingId = this.$newLineOpeningId.val().trim();
    const lineName = this.$newLineName.val().trim();
    const lineId = (this.$newLineId.val().trim() || slugifyId(lineName)).trim();
    const movesText = this.$newLineMoves.val().trim();
    const drillSide = normalizeDrillSide(this.$newLineDrillSide.val()) || "white";
    const startFen = this.$newLineStartFen.val().trim();
    if (!openingId) {
      throw new Error("Opening ID is required.");
    }
    if (!lineName) {
      throw new Error("Line name is required.");
    }
    if (!lineId) {
      throw new Error("Line ID is required.");
    }
    if (!movesText) {
      throw new Error("Moves are required.");
    }
    if (this.data.linesById[lineId]) {
      throw new Error(`Line ID already exists in the loaded data: ${lineId}`);
    }
    const parsed = parseStudyLineMoves(movesText, this.$newLineNotation.val(), startFen);
    const lineRow = {
      opening_id: openingId,
      line_id: lineId,
      line_name: lineName,
      line_group: "",
      drill_side: drillSide,
      start_fen: startFen,
      tags: (this.$newLineTags && this.$newLineTags.length) ? this.$newLineTags.val().trim() : "",
      moves_pgn: parsed.movesPgn
    };
    const openingRow = {
      opening_id: openingId,
      opening_name: this.$newLineOpeningName.val().trim() || openingId,
      side: drillSide,
      starting_fen: startFen,
      description: "",
      tags: "",
      published: "TRUE",
      book_max_plies_game_mode: "",
      allow_transpositions: "TRUE"
    };
    let parentNodeId = "";
    const nodes = parsed.moves.map((move, index) => {
      const nodeId = `${lineId}_${String(index + 1).padStart(3, "0")}`;
      const row = {
        opening_id: openingId,
        line_id: lineId,
        node_id: nodeId,
        parent_node_id: parentNodeId,
        move_uci: move.uci,
        learn_prompt: "",
        mistake_map: "",
        fen_before: move.fenBefore,
        fen_key: move.fenKey,
        fen_after: move.fenAfter,
        fen_after_key: move.fenAfterKey
      };
      parentNodeId = nodeId;
      return row;
    });
    return {
      version: 1,
      action: "createLine",
      auth: {},
      opening: {
        create: this.$newLineCreateOpening.prop("checked"),
        row: openingRow
      },
      line: lineRow,
      nodes,
      thumbnail: {
        line_id: lineId,
        command: `python scripts\\generate_missing_thumbnails.py --line-ids ${lineId}`
      },
      source: {
        app: "ChessGym",
        created_at: new Date().toISOString()
      }
    };
  },
  formatNewLinePreview(payload) {
    const sections = [];
    if (payload.opening.create) {
      sections.push("# openings tab");
      sections.push(rowsToTsv([objectToRow(payload.opening.row, OPENING_HEADERS)]));
      sections.push("");
    }
    sections.push("# lines tab");
    sections.push(rowsToTsv([objectToRow(payload.line, LINE_HEADERS)]));
    sections.push("");
    sections.push("# nodes tab");
    sections.push(rowsToTsv(payload.nodes.map((node) => objectToRow(node, NODE_HEADERS))));
    sections.push("");
    sections.push(`# thumbnail`);
    sections.push(payload.thumbnail.command);
    return sections.join("\n");
  },
  copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        const succeeded = document.execCommand("copy");
        if (succeeded) {
          resolve();
        } else {
          reject(new Error("execCommand copy failed"));
        }
      } catch (error) {
        reject(error);
      } finally {
        document.body.removeChild(textarea);
      }
    });
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
    this.fetchDataset()
      .then((dataset) => {
        this.data.openings = dataset.openings;
        this.data.lines = dataset.lines;
        this.data.nodes = dataset.nodes;
        this.data.mistakeTemplates = dataset.mistake_templates;
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
        this.refreshAdminPanel();
      })
      .catch((error) => {
        console.error(error);
        this.setStatus("Failed to load data. Please refresh.");
        this.showLoading(true, "Failed to load data.");
      });
  },
  fetchDataset() {
    const tryAdminApi = () => {
      if (!isAdminMode()) {
        return Promise.reject(new Error("admin disabled"));
      }
      return fetch(`${ADMIN_API_BASE}/data`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`admin api ${res.status}`))));
    };
    const tryLocalJson = () => {
      const names = ["openings", "lines", "nodes", "mistake_templates"];
      const fetches = names.map((name) =>
        fetch(`${LOCAL_DATA_BASE}/${name}.json`, { cache: "no-store" }).then((res) =>
          res.ok ? res.json() : Promise.reject(new Error(`${name}.json ${res.status}`))
        )
      );
      return Promise.all(fetches).then(([openings, lines, nodes, mistake_templates]) => ({
        openings, lines, nodes, mistake_templates
      }));
    };
    return tryAdminApi().catch(() => tryLocalJson());
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
    });

    this.data.nodes.forEach((node) => {
      const lineId = node.line_id;
      if (!lineId) {
        return;
      }
      node.move_uci = normalizeUci(node.move_uci);
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
    return this.compareNodesDeterministic(a, b);
  },
  buildComputedFenIndexes() {
    this.data.nodesByOpeningFen = {};
    this.data.nodesByFen = {};
    const chess = new Chess();
    this.data.nodes.forEach((node) => {
      node._fen_indexed = false;
    });

    this.data.lines.forEach((line) => {
      const lineId = line.line_id;
      const opening = this.data.openingsById[line.opening_id];
      const startFen = line.start_fen || (opening ? opening.starting_fen : "") || "start";
      const rootKeys = this.data.rootNodesByLineId[lineId] || [];
      rootKeys.forEach((rootKey) => {
        this.traverseNodeFen(line, rootKey, startFen, 1, chess);
      });
    });

    this.data.nodes.forEach((node) => {
      const fenKey = normalizeFen(node.fen_key || node.fen_before || "");
      if (!node._fen_indexed && fenKey) {
        node._fen_key = fenKey;
        node._fen_before = node.fen_before || node.fen_key || "";
        node._fen_after = node.fen_after || "";
        node._fen_after_key = normalizeFen(node.fen_after_key || node.fen_after || "");
        this.indexNodeFen(node.opening_id, fenKey, node._key);
      }
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
    Object.keys(this.data.nodesByFen).forEach((fenKey) => {
      this.data.nodesByFen[fenKey].sort((aKey, bKey) => {
        const aNode = this.data.nodesById[aKey];
        const bNode = this.data.nodesById[bKey];
        return this.compareNodesByPreference(aNode, bNode);
      });
    });
  },
  traverseNodeFen(line, nodeKey, fenBefore, depth, chess) {
    const node = this.data.nodesById[nodeKey];
    if (!node) {
      return;
    }
    if (!loadFenForChess(chess, fenBefore)) {
      console.warn("Failed to load FEN for node:", node.node_id, fenBefore);
      return;
    }
    const fullFenBefore = chess.fen();
    node._fen_before = fullFenBefore;
    node._fen_key = normalizeFen(fullFenBefore);
    node._depth = depth;
    const move = applyMoveUCI(chess, node.move_uci);
    if (!move) {
      console.warn("Illegal move in node:", line.line_id, node.node_id, node.move_uci);
      return;
    }
    const afterFen = chess.fen();
    node._fen_after = afterFen;
    node._fen_after_key = normalizeFen(afterFen);
    node._san = move.san || "";

    this.indexNodeFen(line.opening_id, node._fen_key, node._key);

    const children = this.data.childrenByParentKey[nodeKey] || [];
    children.forEach((childKey) => {
      this.traverseNodeFen(line, childKey, afterFen, depth + 1, chess);
    });
  },
  indexNodeFen(openingId, fenKey, nodeKey) {
    if (!fenKey || !nodeKey) {
      return;
    }
    const node = this.data.nodesById[nodeKey];
    if (node && node._fen_indexed) {
      return;
    }
    if (node) {
      node._fen_indexed = true;
    }
    if (!this.data.nodesByFen[fenKey]) {
      this.data.nodesByFen[fenKey] = [];
    }
    this.data.nodesByFen[fenKey].push(nodeKey);
    if (!openingId) {
      return;
    }
    if (!this.data.nodesByOpeningFen[openingId]) {
      this.data.nodesByOpeningFen[openingId] = {};
    }
    if (!this.data.nodesByOpeningFen[openingId][fenKey]) {
      this.data.nodesByOpeningFen[openingId][fenKey] = [];
    }
    this.data.nodesByOpeningFen[openingId][fenKey].push(nodeKey);
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
  findTranspositionCandidate(fenKey, mode = this.state.mode, currentLineId = this.state.sessionLineId) {
    const candidates = this.getCandidateNodesForFen(this.state.openingId, fenKey, mode, currentLineId);
    return this.pickBestCandidate(candidates, this.state.sessionLineId);
  },
  switchSessionToNode(node, options = {}) {
    if (!node) {
      return;
    }
    const { announce = false } = options;
    this.state.sessionLineId = node.line_id;
    this.state.lineId = node.line_id;
    this.updateLineSelectionDisplay();
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
      draggable: true,
      onDragStart: (source, piece) => this.handleDragStart(source, piece),
      onDrop: (source, target) => this.handleDrop(source, target),
      onSnapEnd: () => this.board.position(this.chess.fen()),
      pieceTheme
    });

    this.sounds.move = new Audio("sounds/move.mp3");
    this.sounds.capture = new Audio("sounds/capture.mp3");

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
    if (nextState) {
      this.updateSelectorThumbnails();
    } else {
      this.closeAllSelectLists();
    }
  },
  pickDefaultLine() {
    const openings = this.data.openings.filter((o) => isPublished(o.published));
    const openingIds = new Set(openings.map((opening) => opening.opening_id));
    const candidateLines = this.data.lines.filter((line) => openingIds.has(line.opening_id));
    if (!candidateLines.length) {
      return null;
    }
    return weightedPick(candidateLines, (line) => this.getLineSelectionWeight(line, line.opening_id));
  },
  selectDefaultMode() {
    const openings = this.data.openings.filter((o) => isPublished(o.published));
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
  pickWeightedDisplayLine(lines, openingId = this.state.openingId) {
    const pool = (lines || []).filter(Boolean);
    return weightedPick(pool, (line) => this.getLineSelectionWeight(line, openingId));
  },
  populateSelectors(defaults = {}) {
    const openings = this.data.openings
      .filter((o) => isPublished(o.published))
      .slice()
      .sort((a, b) => {
        const aName = (a.opening_name || a.opening_id || "").toString();
        const bName = (b.opening_name || b.opening_id || "").toString();
        return aName.localeCompare(bName, undefined, { sensitivity: "base" });
      });
    if (openings.length === 0) {
      return;
    }
    const openingId = defaults.openingId || openings[0].opening_id;
    this.state.openingId = openingId;
    this.renderOpeningOptions(openings);
    this.updateOpeningSelectionDisplay();
    this.state.lineId = defaults.lineId || this.state.lineId || "";
    this.populateLines(defaults.lineId);
  },
  populateLines(preferredLineId) {
    const lines = this.data.linesByOpeningId[this.state.openingId] || [];
    const filteredLines = this.getManualSelectionLines(lines);
    const displayLines = this.sortLinesForSelector(filteredLines);
    const currentSelection = preferredLineId || this.state.lineId;
    let nextLine = null;
    if (currentSelection && currentSelection !== "any") {
      nextLine = displayLines.find((line) => line.line_id === currentSelection) || null;
    }
    if (!nextLine) {
      nextLine = this.pickWeightedDisplayLine(displayLines);
    }
    this.state.lineId = nextLine ? nextLine.line_id : "";
    this.renderLineOptionsForCurrentState(displayLines);
    this.updateLineSelectionDisplay();
    this.updateProgress();
    this.updateSideSelector();
    this.updateSelectorThumbnails();
  },
  renderLineOptionsForCurrentState(defaultLines) {
    this.updatePinnedLinesFilterButton();
    if (this.state.linePinnedOnly) {
      this.renderPinnedLineResults(this.state.lineSearchQuery);
      return;
    }
    if (this.state.lineSearchQuery && this.state.lineSearchQuery.trim()) {
      this.renderLineSearchResults(this.state.lineSearchQuery);
      return;
    }
    this.renderLineOptions(defaultLines);
  },
  sortLinesForSelector(lines) {
    return (lines || []).slice().sort((a, b) => {
      const aPinned = this.isLinePinned(a.line_id) ? 0 : 1;
      const bPinned = this.isLinePinned(b.line_id) ? 0 : 1;
      if (aPinned !== bPinned) {
        return aPinned - bPinned;
      }
      const aName = (a.line_name || a.line_id || "").toString();
      const bName = (b.line_name || b.line_id || "").toString();
      const byName = aName.localeCompare(bName, undefined, { sensitivity: "base" });
      if (byName !== 0) {
        return byName;
      }
      return (a.line_id || "").toString().localeCompare((b.line_id || "").toString(), undefined, { sensitivity: "base" });
    });
  },
  isLinePinned(lineId) {
    return !!(lineId && this.state.pinnedLines && this.state.pinnedLines[lineId]);
  },
  togglePinnedLine(lineId) {
    if (!lineId) return;
    if (!this.state.pinnedLines) {
      this.state.pinnedLines = {};
    }
    if (this.state.pinnedLines[lineId]) {
      delete this.state.pinnedLines[lineId];
    } else {
      this.state.pinnedLines[lineId] = true;
    }
    savePinnedLines(this.state.pinnedLines);
    if (this.state.linePinnedOnly) {
      this.renderPinnedLineResults(this.state.lineSearchQuery);
    } else if (this.state.lineSearchQuery && this.state.lineSearchQuery.trim()) {
      this.renderLineSearchResults(this.state.lineSearchQuery);
    } else {
      this.populateLines(this.state.lineId);
    }
    this.updatePinnedLinesFilterButton();
    this.adminPopulatePicker();
  },
  onOpeningChange(nextOpeningId) {
    if (!nextOpeningId) {
      return;
    }
    this.state.openingId = nextOpeningId;
    TTS.stop();
    this.updateOpeningSelectionDisplay();
    this.populateLines();
    this.prepareSession();
  },
  onLineChange(nextLineId) {
    if (!nextLineId) {
      return;
    }
    this.state.lineId = nextLineId;
    TTS.stop();
    this.updateLineSelectionDisplay();
    this.updateProgress();
    this.updateSideSelector();
    this.updateSelectorThumbnails();
    this.prepareSession();
    this.refreshAdminPanel();
  },
  renderOpeningOptions(openings) {
    this.$openingList.empty();
    openings.forEach((opening) => {
      const optionId = opening.opening_id;
      const label = opening.opening_name || optionId;
      this.$openingList.append(
        this.buildSelectOption(optionId, label, optionId, "Opening option thumbnail", this.state.openingId)
      );
    });
    this.syncSelectSizer("opening");
  },
  renderLineOptions(lines) {
    const $target = this.$lineSelectOptions && this.$lineSelectOptions.length ? this.$lineSelectOptions : this.$lineList;
    $target.empty();
    lines.forEach((line) => {
      const optionId = line.line_id;
      const label = line.line_name || optionId;
      $target.append(
        this.buildSelectOption(optionId, label, optionId, "Line option thumbnail", this.state.lineId, {
          pinnable: true,
          lineId: optionId
        })
      );
    });
    this.syncSelectSizer("line");
  },
  onLineSearchChange() {
    const query = (this.$lineSearchInput && this.$lineSearchInput.val()) || "";
    this.state.lineSearchQuery = query;
    if (this.state.linePinnedOnly) {
      this.ensureLineSelectOpen();
      this.renderPinnedLineResults(query);
      return;
    }
    if (!query.trim()) {
      this.populateLines(this.state.lineId);
      return;
    }
    this.ensureLineSelectOpen();
    this.renderLineSearchResults(query);
  },
  togglePinnedLinesFilter() {
    this.state.linePinnedOnly = !this.state.linePinnedOnly;
    this.updatePinnedLinesFilterButton();
    this.ensureLineSelectOpen();
    if (this.state.linePinnedOnly) {
      this.renderPinnedLineResults(this.state.lineSearchQuery);
      return;
    }
    if (this.state.lineSearchQuery && this.state.lineSearchQuery.trim()) {
      this.renderLineSearchResults(this.state.lineSearchQuery);
      return;
    }
    this.populateLines(this.state.lineId);
  },
  updatePinnedLinesFilterButton() {
    if (!this.$pinnedLinesBtn || !this.$pinnedLinesBtn.length) {
      return;
    }
    const active = !!this.state.linePinnedOnly;
    this.$pinnedLinesBtn
      .toggleClass("is-active", active)
      .attr("aria-pressed", String(active))
      .attr("aria-label", active ? "Show current opening lines" : "Show pinned lines")
      .attr("title", active ? "Show current opening lines" : "Show pinned lines");
  },
  ensureLineSelectOpen() {
    if (this.$lineList && !this.$lineList.hasClass("is-open")) {
      this.$lineList.addClass("is-open");
      this.$lineButton.attr("aria-expanded", "true");
    }
  },
  renderLineSearchResults(query) {
    const needle = (query || "").trim().toLowerCase();
    const $target = this.$lineSelectOptions && this.$lineSelectOptions.length ? this.$lineSelectOptions : this.$lineList;
    $target.empty();
    if (!needle) {
      return;
    }
    const matches = (this.data.lines || []).filter((line) => {
      const haystack = `${line.line_name || ""} ${line.line_id || ""} ${line.tags || ""} ${this.lookupOpeningName(line.opening_id) || ""}`.toLowerCase();
      return haystack.includes(needle);
    });
    matches.sort((a, b) => this.compareCrossOpeningLines(a, b, { pinnedFirst: true }));
    if (!matches.length) {
      $target.append('<div class="select-empty">No lines match.</div>');
      this.syncSelectSizer("line");
      return;
    }
    this.renderCrossOpeningLineOptions(matches.slice(0, 80));
  },
  renderPinnedLineResults(query) {
    const needle = (query || "").trim().toLowerCase();
    const $target = this.$lineSelectOptions && this.$lineSelectOptions.length ? this.$lineSelectOptions : this.$lineList;
    $target.empty();
    const matches = (this.data.lines || []).filter((line) => {
      if (!this.isLinePinned(line.line_id)) {
        return false;
      }
      if (!needle) {
        return true;
      }
      const haystack = `${line.line_name || ""} ${line.line_id || ""} ${line.tags || ""} ${this.lookupOpeningName(line.opening_id) || ""}`.toLowerCase();
      return haystack.includes(needle);
    });
    matches.sort((a, b) => this.compareCrossOpeningLines(a, b));
    if (!matches.length) {
      $target.append(`<div class="select-empty">${needle ? "No pinned lines match." : "No pinned lines yet."}</div>`);
      this.syncSelectSizer("line");
      return;
    }
    this.renderCrossOpeningLineOptions(matches);
  },
  renderCrossOpeningLineOptions(lines) {
    const $target = this.$lineSelectOptions && this.$lineSelectOptions.length ? this.$lineSelectOptions : this.$lineList;
    (lines || []).forEach((line) => {
      const openingName = this.lookupOpeningName(line.opening_id) || line.opening_id;
      const label = line.line_name || line.line_id;
      $target.append(
        this.buildSelectOption(line.line_id, label, line.line_id, "Line option thumbnail", this.state.lineId, {
          pinnable: true,
          lineId: line.line_id,
          openingId: line.opening_id,
          metaText: openingName,
          crossOpening: true
        })
      );
    });
    this.syncSelectSizer("line");
  },
  compareCrossOpeningLines(a, b, options = {}) {
    if (options.pinnedFirst) {
      const aPinned = this.isLinePinned(a.line_id) ? 0 : 1;
      const bPinned = this.isLinePinned(b.line_id) ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;
    }
    const aOpening = (this.lookupOpeningName(a.opening_id) || a.opening_id || "").toString();
    const bOpening = (this.lookupOpeningName(b.opening_id) || b.opening_id || "").toString();
    const byOpening = aOpening.localeCompare(bOpening, undefined, { sensitivity: "base" });
    if (byOpening !== 0) return byOpening;
    const aName = (a.line_name || a.line_id || "").toString();
    const bName = (b.line_name || b.line_id || "").toString();
    const byName = aName.localeCompare(bName, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    return (a.line_id || "").toString().localeCompare((b.line_id || "").toString(), undefined, { sensitivity: "base" });
  },
  lookupOpeningName(openingId) {
    const opening = this.data.openingsById[openingId];
    return opening ? opening.opening_name || opening.opening_id : openingId || "";
  },
  buildSelectOption(value, label, thumbnailId, thumbnailLabel, selectedValue, options) {
    const opts = options || {};
    const $option = $("<button>")
      .addClass("select-option")
      .attr("type", "button")
      .attr("role", "option")
      .attr("data-value", value);
    if (thumbnailId) {
      $option.attr("data-thumbnail-id", thumbnailId);
    }
    if (opts.openingId) {
      $option.attr("data-opening-id", opts.openingId);
    }
    if (selectedValue && value === selectedValue) {
      $option.addClass("is-selected");
    }
    const $thumb = $("<img>")
      .addClass("option-thumb is-placeholder")
      .attr("src", THUMBNAIL_PLACEHOLDER_SRC)
      .attr("alt", "");
    const $label = $("<span>").addClass("option-label").text(label);
    $option.append($thumb, $label);
    if (opts.metaText) {
      const $meta = $("<span>").addClass("option-meta").text(opts.metaText);
      $option.append($meta);
    }
    if (opts.pinnable && opts.lineId) {
      const isPinned = this.isLinePinned(opts.lineId);
      const $pin = $("<span>")
        .addClass("pin-toggle")
        .attr("role", "button")
        .attr("tabindex", "0")
        .attr("aria-label", isPinned ? "Unpin line" : "Pin line")
        .attr("title", isPinned ? "Unpin line" : "Pin line")
        .toggleClass("is-pinned", isPinned)
        .text(isPinned ? "★" : "☆");
      $pin.on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.togglePinnedLine(opts.lineId);
      });
      $pin.on("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          this.togglePinnedLine(opts.lineId);
        }
      });
      $option.append($pin);
    }
    if (thumbnailId) {
      this.setThumbnail($thumb, thumbnailId, thumbnailLabel);
    } else {
      this.clearThumbnail($thumb);
    }
    return $option;
  },
  showThumbnailPreview(event) {
    const $option = $(event.currentTarget);
    const thumbnailId = $option.data("thumbnailId");
    if (!thumbnailId) {
      this.hideThumbnailPreview();
      return;
    }
    if (this.thumbnailCache.get(thumbnailId) === false) {
      this.hideThumbnailPreview();
      return;
    }
    this.setThumbnail(this.$thumbnailPreviewImage, thumbnailId, "Thumbnail preview");
    this.$thumbnailPreview.removeClass("hidden");
    this.positionThumbnailPreview(event);
  },
  positionThumbnailPreview(event) {
    if (!this.$thumbnailPreview || this.$thumbnailPreview.hasClass("hidden")) {
      return;
    }
    const offset = 16;
    const previewWidth = this.$thumbnailPreview.outerWidth() || 0;
    const previewHeight = this.$thumbnailPreview.outerHeight() || 0;
    let left = event.clientX + offset;
    let top = event.clientY + offset;
    if (previewWidth && left + previewWidth > window.innerWidth - 8) {
      left = event.clientX - previewWidth - offset;
    }
    if (previewHeight && top + previewHeight > window.innerHeight - 8) {
      top = event.clientY - previewHeight - offset;
    }
    this.$thumbnailPreview.css({ left: `${left}px`, top: `${top}px` });
  },
  hideThumbnailPreview() {
    if (!this.$thumbnailPreview) {
      return;
    }
    this.$thumbnailPreview.addClass("hidden");
  },
  updateOpeningSelectionDisplay() {
    const opening = this.data.openingsById[this.state.openingId];
    const label = opening ? opening.opening_name || opening.opening_id : "Select opening";
    this.$openingButton.text(label);
    this.updateSelectedOption(this.$openingList, this.state.openingId);
    this.syncSelectSizer("opening");
  },
  updateLineSelectionDisplay() {
    const line = this.data.linesById[this.state.lineId] || this.data.linesById[this.state.sessionLineId] || null;
    const lineLabel = line ? (line.line_name || line.line_id) : (this.state.lineId || "Select line");
    this.$lineButton.text(lineLabel);
    this.updateSelectedOption(this.$lineList, this.state.lineId);
    this.syncSelectSizer("line");
  },
  syncSelectSizer(type) {
    const { button, list } = this.getSelectElements(type);
    if (!button || !button.length) {
      return;
    }
    const $select = button.closest(".custom-select");
    if (!$select.length) {
      return;
    }
    let $sizer = $select.children(".select-width-sizer");
    if (!$sizer.length) {
      $sizer = $("<span>")
        .addClass("select-width-sizer")
        .attr("aria-hidden", "true");
      $select.append($sizer);
    }
    const lines = [];
    const addLine = (value) => {
      const text = (value || "").toString().replace(/\s+/g, " ").trim();
      if (text) {
        lines.push(text);
      }
    };
    addLine(button.text());
    if (list && list.length) {
      list.find(".option-label, .option-meta, .select-empty").each((_, element) => {
        addLine($(element).text());
      });
    }
    if (type === "line" && this.$lineSearchInput && this.$lineSearchInput.length) {
      addLine(this.$lineSearchInput.attr("placeholder"));
    }
    const uniqueLines = [...new Set(lines)];
    $sizer.empty();
    (uniqueLines.length ? uniqueLines : [button.text() || "Select"]).forEach((line, index) => {
      if (index > 0) {
        $sizer.append(document.createElement("br"));
      }
      $sizer.append(document.createTextNode(line));
    });
    const hasPinnableOptions = type === "line" && !!(list && list.find(".pin-toggle").length);
    $select.toggleClass("has-pinnable-options", hasPinnableOptions);
  },
  updateSelectedOption($list, selectedValue) {
    if (!$list) {
      return;
    }
    $list.find(".select-option").each((_, option) => {
      const $option = $(option);
      const value = $option.data("value");
      $option.toggleClass("is-selected", value === selectedValue);
    });
  },
  handleSelectOption(event, type) {
    const $target = $(event.currentTarget);
    const value = $target.data("value");
    if (type === "opening") {
      this.closeSelectList("opening");
      this.onOpeningChange(value);
      return;
    }
    const crossOpeningId = $target.attr("data-opening-id");
    this.closeSelectList("line");
    if (crossOpeningId && crossOpeningId !== this.state.openingId) {
      this.onOpeningChange(crossOpeningId);
    }
    this.onLineChange(value);
  },
  toggleSelectList(type) {
    const { button, list } = this.getSelectElements(type);
    if (!button || !list) {
      return;
    }
    const isOpen = list.hasClass("is-open");
    this.closeAllSelectLists();
    if (!isOpen) {
      list.addClass("is-open");
      button.attr("aria-expanded", "true");
    }
  },
  closeSelectList(type) {
    const { button, list } = this.getSelectElements(type);
    if (!button || !list) {
      return;
    }
    list.removeClass("is-open");
    button.attr("aria-expanded", "false");
    this.hideThumbnailPreview();
    if (type === "line" && this.state.lineSearchQuery) {
      this.$lineSearchInput.val("");
      this.state.lineSearchQuery = "";
      this.populateLines(this.state.lineId);
    }
  },
  closeAllSelectLists() {
    this.$openingList.removeClass("is-open");
    this.$lineList.removeClass("is-open");
    this.$openingButton.attr("aria-expanded", "false");
    this.$lineButton.attr("aria-expanded", "false");
    this.hideThumbnailPreview();
    if (this.$lineSearchInput && this.state.lineSearchQuery) {
      this.$lineSearchInput.val("");
      this.state.lineSearchQuery = "";
      this.populateLines(this.state.lineId);
    }
  },
  handleDocumentClick(event) {
    const target = event.target;
    if (!target) {
      return;
    }
    if ($(target).closest(".custom-select").length) {
      return;
    }
    this.closeAllSelectLists();
  },
  getSelectElements(type) {
    if (type === "opening") {
      return { button: this.$openingButton, list: this.$openingList };
    }
    if (type === "line") {
      return { button: this.$lineButton, list: this.$lineList };
    }
    return { button: null, list: null };
  },
  updateSelectorThumbnails() {
    this.setThumbnail(this.$openingThumb, this.state.openingId, "Opening thumbnail");
    const lineId = this.state.lineId || this.state.sessionLineId;
    if (lineId && lineId !== "any") {
      this.setThumbnail(this.$lineThumb, lineId, "Line thumbnail");
      return;
    }
    this.clearThumbnail(this.$lineThumb);
  },
  bumpThumbnailVersion(id) {
    if (!id) {
      return;
    }
    this.thumbnailCache.delete(id);
    this.thumbnailVersions.set(id, Date.now().toString(36));
    this.refreshThumbnailElements(id);
  },
  thumbnailUrl(id) {
    const url = `Thumbnails/${id}.png`;
    const version = this.thumbnailVersions.get(id);
    return version ? `${url}?v=${encodeURIComponent(version)}` : url;
  },
  refreshThumbnailElements(id) {
    $("img").each((_, img) => {
      const $img = $(img);
      if ($img.attr("data-thumbnail-id") === id) {
        this.applyThumbnail($img, id, $img.attr("data-thumbnail-label") || "Thumbnail");
      }
    });
  },
  setThumbnail($img, id, label) {
    if (!$img) {
      return;
    }
    if (!id) {
      this.clearThumbnail($img);
      return;
    }
    const cached = this.thumbnailCache.get(id);
    if (cached === true) {
      this.applyThumbnail($img, id, label);
      return;
    }
    // Do not hard-cache misses forever: thumbnails can be generated after page load.
    if (cached === false) {
      this.thumbnailCache.delete(id);
    }
    this.clearThumbnail($img);
    const url = this.thumbnailUrl(id);
    const probe = new Image();
    probe.onload = () => {
      this.thumbnailCache.set(id, true);
      this.applyThumbnail($img, id, label);
    };
    probe.onerror = () => {
      this.clearThumbnail($img);
    };
    probe.src = url;
  },
  applyThumbnail($img, id, label) {
    const url = this.thumbnailUrl(id);
    $img.attr("src", url);
    $img.attr("alt", `${label} ${id}`);
    $img.attr("data-thumbnail-id", id);
    $img.attr("data-thumbnail-label", label);
    $img.removeClass("is-placeholder");
    if ($img.hasClass("select-thumb")) {
      $img.closest(".select-with-thumb").addClass("with-thumb");
    }
  },
  clearThumbnail($img) {
    $img.attr("alt", "");
    $img.attr("src", THUMBNAIL_PLACEHOLDER_SRC);
    $img.removeAttr("data-thumbnail-id data-thumbnail-label");
    $img.addClass("is-placeholder");
    if ($img.hasClass("select-thumb")) {
      $img.closest(".select-with-thumb").removeClass("with-thumb");
    }
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
    TTS.stop();
    this.populateLines(this.state.lineId);
    this.updateSideSelector();
    this.$strengthField.toggle(this.state.mode === "game");
    this.$hint.prop("disabled", this.state.mode === "game");
    this.$reveal.prop("disabled", this.state.mode !== "practice");
    this.$dueBtn.toggle(this.state.mode === "practice");
    this.$dueBtn.text(this.state.studyDueOnly ? "Study All Lines" : "Study Due Lines");
    if (this.state.mode !== "game") {
      this.$engineEval.text("");
      this.setWinProbSource("", "");
    }
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
    if (this.state.freeModeActive) {
      this.copyFreeMovesToClipboard(this.getFreeModeMoves(), { showFeedback: false });
    }
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
    this.state.databaseTrace = [];
    this.state.hintActive = false;
    this.state.freeModeActive = false;
    this.state.freeModeSnapshot = null;
    this.updateFreeModeButton();
    this.state.engineBusy = false;
    this.state.sessionLineId = null;
    this.state.moveHistory = [];
    this.state.redoMoves = [];
    this.state.promptHistoryByFenBySide = {};
    this.state.promptChainBySide = {
      white: { current: "", previous: "" },
      black: { current: "", previous: "" }
    };
    this.clearCoachOverride();
    this.$engineEval.text("");
    this.clearSelection();
    this.clearHintHighlight();
    this.clearLastMoveHighlight();
    this.updateNavigationControls();
    this.updateWinProbability(null);
    this.setWinProbSource("", "");

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

    const fenLoaded = loadFenForChess(this.chess, fen);
    this.board.position(this.chess.fen());
    if (!fenLoaded) {
      this.state.sessionActive = false;
      this.stopLiveAnalysis();
      this.setLineStatus(line);
      this.setStatus("Invalid line/opening FEN. Session start stopped.");
      this.setComment(`Invalid line/opening FEN: <code>${fen}</code>. Fix the line/opening data before starting.`);
      console.error("Invalid line/opening FEN while resetting session:", fen);
      return;
    }
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
    if (this.state.pendingAnalysisTimer) {
      clearTimeout(this.state.pendingAnalysisTimer);
      this.state.pendingAnalysisTimer = null;
    }
  },
  prepareGameMode(selectedLine) {
    this.state.sessionLineId = selectedLine ? selectedLine.line_id : null;
    this.state.databaseTrace = [];
    this.syncDatabaseModeForCurrentPosition();
    this.updateProgress();
    this.setStatus("Game mode: your move.");
    this.setComment("Known database positions use repertoire replies. Stockfish starts only after you leave the database.");
    this.setLineStatus(selectedLine);
  },
  handleFreeModeToggle() {
    if (!this.state.freeModeActive) {
      this.startFreeMode();
      return;
    }
    const freeMoves = this.getFreeModeMoves();
    this.copyFreeMovesToClipboard(freeMoves, { showFeedback: false })
      .then((result) => {
        this.endFreeMode();
        this.showFreeCopyResult(result);
      });
  },
  startFreeMode() {
    this.stopPendingActions();
    this.state.sessionActive = true;
    this.state.engineBusy = false;
    this.state.freeModeActive = true;
    this.state.freeModeSnapshot = {
      fen: this.chess ? this.chess.fen() : "start",
      moveHistory: [...this.state.moveHistory],
      redoMoves: [...this.state.redoMoves],
      currentDepth: this.state.currentDepth,
      inBook: this.state.inBook,
      databaseTrace: [...this.state.databaseTrace],
      statusText: this.state.statusText,
      lastCoachComment: this.state.lastCoachComment,
      coachCommentBySide: JSON.parse(JSON.stringify(this.state.coachCommentBySide))
    };
    this.clearSelection();
    this.updateFreeModeButton();
    this.setStatus("Free play: both sides.");
    this.setComment("Free play enabled. Click Copy UCI to copy only the moves you play from here.");
  },
  endFreeMode() {
    const snapshot = this.state.freeModeSnapshot;
    this.state.freeModeActive = false;
    if (snapshot) {
      this.state.moveHistory = [...snapshot.moveHistory];
      this.state.redoMoves = [...snapshot.redoMoves];
      this.state.currentDepth = snapshot.currentDepth;
      this.state.inBook = snapshot.inBook;
      this.state.databaseTrace = [...(snapshot.databaseTrace || [])];
      this.state.statusText = snapshot.statusText;
      this.state.lastCoachComment = snapshot.lastCoachComment;
      this.state.coachCommentBySide = snapshot.coachCommentBySide;
      this.state.freeModeSnapshot = null;
      this.chess.reset();
      if (snapshot.fen && snapshot.fen !== "start") {
        this.chess.load(snapshot.fen);
      }
      this.board.position(this.chess.fen());
    }
    this.clearSelection();
    this.updateFreeModeButton();
    this.updateLastMoveHighlight();
    this.updateNavigationControls();
    this.updateProgress();
    if (!snapshot) {
      if (this.state.mode === "learning") {
        this.showLearningPrompt();
      }
      if (this.state.mode === "learning" || this.state.mode === "practice") {
        this.setStatus("Your move.");
      }
    }
    this.renderCoachComment();
  },
  getFreeModeMoves() {
    const snapshot = this.state.freeModeSnapshot;
    const startIndex = snapshot && Array.isArray(snapshot.moveHistory) ? snapshot.moveHistory.length : 0;
    return this.state.moveHistory.slice(startIndex);
  },
  updateFreeModeButton() {
    if (!this.$free || !this.$free.length) {
      return;
    }
    const isActive = !!this.state.freeModeActive;
    this.$free
      .toggleClass("is-active", isActive)
      .attr("aria-pressed", isActive ? "true" : "false")
      .text(isActive ? "Copy UCI" : "Free")
      .attr(
        "title",
        isActive
          ? "Exit free play and copy the UCI moves played in Free mode."
          : "Enable free play for both sides."
      );
    if (this.$flip && this.$flip.length) {
      this.$flip.toggleClass("hidden", !isActive);
    }
  },
  handleFlipBoard() {
    if (!this.board || !this.state.freeModeActive) {
      return;
    }
    const current = (this.board.orientation && this.board.orientation()) || this.state.userSide || "white";
    const next = current === "white" ? "black" : "white";
    this.board.orientation(next);
  },
  showFreeCopyResult(result) {
    if (!result || result.status === "empty") {
      this.setStatus("No Free moves to copy.");
      this.setComment("Free play ended. No new UCI moves were played.");
      return;
    }
    if (result.status === "copied") {
      this.state.lastFreeMovesText = result.movesText || "";
      this.setStatus("Free UCI moves copied.");
      this.setComment(`Copied ${result.count} Free ${result.count === 1 ? "move" : "moves"} to clipboard.`);
      return;
    }
    this.setStatus("Unable to copy Free moves.");
    this.setComment("Clipboard access failed, but Free play ended normally.");
  },
  copyFreeMovesToClipboard(moves = this.getFreeModeMoves(), options = {}) {
    const { showFeedback = true } = options;
    const moveList = Array.isArray(moves) ? moves : [];
    const movesText = moveList.join(" ").trim();
    if (!movesText) {
      const result = { status: "empty", count: 0 };
      if (showFeedback) {
        this.showFreeCopyResult(result);
      }
      return Promise.resolve(result);
    }
    const onSuccess = () => {
      const result = { status: "copied", count: moveList.length, movesText };
      if (showFeedback) {
        this.showFreeCopyResult(result);
      }
      return result;
    };
    const onFailure = () => {
      const result = { status: "failed", count: moveList.length };
      if (showFeedback) {
        this.showFreeCopyResult(result);
      }
      console.warn("Failed to copy UCI moves to clipboard.");
      return result;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(movesText)
        .then(() => {
          return onSuccess();
        })
        .catch(() => {
          return onFailure();
        });
    }
    return new Promise((resolve) => {
      const textarea = document.createElement("textarea");
      textarea.value = movesText;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        const succeeded = document.execCommand("copy");
        if (succeeded) {
          resolve(onSuccess());
        } else {
          resolve(onFailure());
        }
      } catch (error) {
        resolve(onFailure());
      } finally {
        document.body.removeChild(textarea);
      }
    });
  },
  handleFreeMove(uci, promotion) {
    const legalMove = this.chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion
    });
    if (!legalMove) {
      return "snapback";
    }
    this.playMoveSound(legalMove);
    this.recordMove(moveToUci(legalMove), legalMove);
    this.updateLastMoveHighlight();
    this.setStatus("Free play: move played.");
    return null;
  },
  canMovePiece(square, piece) {
    if (this.chess.game_over()) return false;
    if (!this.state.sessionActive) {
      this.setStatus("Session ready.");
      return false;
    }
    const turn = this.chess.turn() === "w" ? "white" : "black";
    const pieceColor = piece.charAt(0) === "w" ? "white" : "black";
    if (pieceColor !== turn) return false;
    if (!this.state.freeModeActive && turn !== this.state.userSide) return false;
    if (!this.state.freeModeActive && this.state.mode !== "game" && this.state.mode !== "learning" && this.state.mode !== "practice") {
      return false;
    }
    if (!this.state.freeModeActive && (this.state.mode === "learning" || this.state.mode === "practice")) {
      if (!this.getExpectedNode()) return false;
    }
    return true;
  },
  handleDragStart(source, piece) {
    if (!this.canMovePiece(source, piece)) return false;
    // Preserve selectedSquare state for click-to-move (handleDrop reads it);
    // only remove the visual highlight so the board looks clean during drag.
    this.state.dragSource = source;
    this.state.clickHandledInDragCycle = false;
    $("#board .square-55d63").removeClass("square-selected");
    return true;
  },
  handleDrop(source, target) {
    if (!source || !target || target === "offboard") {
      this.state.dragSource = null;
      this.state.clickHandledInDragCycle = false;
      this.clearSelection();
      return "snapback";
    }
    if (source === target) {
      // Same-square drop = mouse click without drag.
      // Touch taps are handled earlier via touchend -> handleSquareClick;
      // clickHandledInDragCycle prevents double-processing here.
      const alreadyHandled = this.state.clickHandledInDragCycle;
      this.state.dragSource = null;
      this.state.clickHandledInDragCycle = false;
      if (!alreadyHandled) {
        const squareEl = $(`#board .square-55d63[data-square='${source}']`);
        if (squareEl.length) {
          this.handleSquareClick(squareEl);
        }
      }
      return "snapback";
    }
    // Actual drag move - clear any lingering selection.
    this.clearSelection();
    this.state.dragSource = null;
    this.state.clickHandledInDragCycle = false;
    const promotion = needsPromotion(source, target, this.chess) ? "q" : undefined;
    const uci = `${source}${target}${promotion || ""}`;
    let result;
    if (this.state.freeModeActive) {
      result = this.handleFreeMove(uci, promotion);
    } else if (this.state.mode === "learning" || this.state.mode === "practice") {
      result = this.handleTrainingMove(uci, promotion);
    } else if (this.state.mode === "game") {
      result = this.handleGameMove(uci, promotion);
    } else {
      return "snapback";
    }
    if (result === "snapback") return "snapback";
    this.startLiveAnalysis();
    return undefined;
  },
  handleSquareClick(squareElement) {
    const square = squareElement.data("square");
    if (!square) {
      return;
    }
    // If called during a touch-drag cycle (touchend fires before window touchend/handleDrop),
    // mark it so handleDrop knows not to double-process the same square.
    if (this.state.dragSource === square) {
      this.state.clickHandledInDragCycle = true;
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
      if (!this.state.freeModeActive && turn !== this.state.userSide) {
        return;
      }
      if (!this.state.freeModeActive && this.state.mode !== "game" && this.state.mode !== "learning" && this.state.mode !== "practice") {
        return;
      }
      if (!this.state.freeModeActive && (this.state.mode === "learning" || this.state.mode === "practice")) {
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

    if (this.state.freeModeActive) {
      this.handleFreeMove(uci, promotion);
    } else if (this.state.mode === "learning" || this.state.mode === "practice") {
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
      return "snapback";
    }

    const fenKeyBefore = expected._fen_key || normalizeFen(this.chess.fen());
    const legalMove = this.chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion
    });

    if (!legalMove) {
      return "snapback";
    }

    const playedUci = moveToUci(legalMove);
    const normalizedPlayedUci = normalizeUci(playedUci);
    const normalizedExpectedUci = normalizeUci(expected.move_uci);
    const fenKeyAfter = normalizeFen(this.chess.fen());
    const plan = this.state.sessionPlan;
    const planDepth = plan ? plan.depthByFenKey[fenKeyAfter] : undefined;
    const currentDepth = Number.isFinite(this.state.currentDepth) ? this.state.currentDepth : -1;
    const opening = this.getSelectedOpening();
    const allowTranspositions = this.state.mode === "game" && opening && isTrue(opening.allow_transpositions);
    const isExpectedMove = normalizedPlayedUci === normalizedExpectedUci;
    const isTranspositionWithinPlan = allowTranspositions && Number.isFinite(planDepth) && planDepth > currentDepth;

    if (!isExpectedMove && !isTranspositionWithinPlan) {
      const branchNode = this.findMistakeBranchNode(fenKeyBefore, playedUci, expected, {
        mode: this.state.mode,
        currentLineId: expected.line_id
      });
      if (branchNode) {
        this.handleMistakeBranchJump(branchNode, expected, playedUci, legalMove);
        return;
      }
      const isOtherLineMove = this.isMoveInOtherLine(fenKeyBefore, playedUci, expected.line_id);
      this.chess.undo();
      if (isOtherLineMove) {
        this.handleWrongMove(playedUci, expected, { message: "Not in this line." });
      } else {
        this.handleWrongMove(playedUci, expected);
      }
      return "snapback";
    }

    this.playMoveSound(legalMove);
    this.recordMove(playedUci, legalMove);
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
  findMistakeBranchNode(fenKeyBefore, uci, expected, options = {}) {
    const openingId = this.state.openingId;
    const { mode = this.state.mode, currentLineId = this.state.sessionLineId } = options;
    const candidates = this.getCandidateNodesForFen(openingId, fenKeyBefore, mode, currentLineId);
    const normalizedUci = normalizeUci(uci);
    const matches = candidates.filter((node) => normalizeUci(node.move_uci) === normalizedUci);
    if (!matches.length) {
      return null;
    }
    const sameLine = expected ? matches.filter((node) => node.line_id === expected.line_id) : [];
    const pool = sameLine.length ? sameLine : matches;
    return pool[Math.floor(Math.random() * pool.length)];
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
    const fenBefore = this.chess.fen();
    const fenKeyBefore = normalizeFen(this.chess.fen());
    const databaseCandidates = this.getDatabaseCandidatesForFenKey(fenKeyBefore);
    const normalizedUci = normalizeUci(uci);
    const legalMove = this.chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion
    });
    if (!legalMove) {
      return "snapback";
    }

    this.playMoveSound(legalMove);
    this.recordMove(uci, legalMove);
    this.updateNavigationControls();
    this.updateLastMoveHighlight();

    const matchedNode = databaseCandidates.find((candidate) => normalizeUci(candidate.move_uci) === normalizedUci);
    if (matchedNode) {
      this.recordDatabaseTrace(matchedNode, legalMove, "player", fenBefore);
    }
    this.syncDatabaseModeForCurrentPosition();

    const turn = this.chess.turn() === "w" ? "white" : "black";
    if (turn !== this.state.userSide) {
      this.setStatus(this.state.inBook ? "Database reply ready..." : "Opponent thinking...");
      this.scheduleOpponentMove(() => this.nextGameTurn());
    } else {
      this.nextGameTurn();
    }
    return;
  },
  nextGameTurn() {
    if (this.chess.game_over()) {
      this.setStatus("Game over.");
      this.showDatabaseTraceSummary();
      return;
    }
    const turn = this.chess.turn() === "w" ? "white" : "black";
    if (turn !== this.state.userSide) {
      if (this.syncDatabaseModeForCurrentPosition()) {
        this.playBookMove();
      } else {
        this.playEngineMove();
      }
    } else {
      this.syncDatabaseModeForCurrentPosition();
      this.setStatus("Your move.");
    }
  },
  playBookMove() {
    this.stopLiveAnalysis();
    const fenKey = normalizeFen(this.chess.fen());
    const fenBefore = this.chess.fen();
    const candidates = this.getDatabaseCandidatesForFenKey(fenKey);
    const expected = this.pickDatabaseNode(candidates);
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
    this.recordDatabaseTrace(expected, move, "database", fenBefore);
    this.board.position(this.chess.fen());
    this.syncDatabaseModeForCurrentPosition();
    this.updateNavigationControls();
    this.updateLastMoveHighlight();
    this.setStatus("Database move played.");
    this.nextGameTurn();
  },
  playEngineMove() {
    if (this.syncDatabaseModeForCurrentPosition()) {
      this.playBookMove();
      return;
    }
    if (!this.engine) {
      this.ensureEngine();
    }
    if (!this.engine) {
      this.setStatus("Engine unavailable.");
      return;
    }
    if (this.state.engineBusy) {
      return;
    }
    this.state.engineBusy = true;
    this.stopLiveAnalysis();
    const expectedFen = this.chess.fen();
    const movetime = getEngineMoveTime(this.$strength.val());
    const sessionId = this.state.engineSessionId;
    this.engine.getBestMove(expectedFen, movetime, (bestmove) => {
      this.state.engineBusy = false;
      if (sessionId !== this.state.engineSessionId || !this.state.engineEnabled) {
        return;
      }
      if (this.chess.fen() !== expectedFen) {
        return;
      }
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
      if (sessionId !== this.state.engineSessionId || !this.state.engineEnabled) {
        return;
      }
      if (this.chess.fen() !== expectedFen) {
        return;
      }
      if (this.state.mode === "game") {
        this.$engineEval.text(evalText);
      }
    });
  },
  handleWrongMove(uci, row, options = {}) {
    this.state.mistakes += 1;
    this.state.wrongAttemptsForPly += 1;
    if (this.state.wrongAttemptsForPly >= 3) {
      this.state.hadLapse = true;
    }
    const mistakeMessage = this.lookupMistake(uci, row);
    if (mistakeMessage) {
      this.setComment(mistakeMessage);
    } else if (options.message) {
      this.setComment(options.message);
    } else if (this.state.mode === "practice") {
      const expectedSan = row ? row._san || "" : "";
      const expectedUci = row ? row.move_uci || "" : "";
      const expectedLabel = expectedSan && expectedUci
        ? `${expectedSan} (${expectedUci})`
        : expectedSan || expectedUci;
      const hint = expectedLabel ? ` Expected: <strong>${expectedLabel}</strong>.` : "";
      this.setComment(`Incorrect.${hint}`);
    } else {
      const expectedSan = row ? row._san || "" : "";
      const expectedUci = row ? row.move_uci || "" : "";
      const expectedLabel = expectedSan && expectedUci
        ? `${expectedSan} (${expectedUci})`
        : expectedSan || expectedUci;
      const hint = expectedLabel ? ` Hint: ${expectedLabel}` : "";
      this.setComment(`Not in this repertoire.${hint}`);
    }
    this.setStatus("Incorrect. Try again.");
  },
  lookupMistake(uci, row) {
    if (!row.mistake_map) {
      return "";
    }
    const normalizedUci = normalizeUci(uci);
    const mapEntries = row.mistake_map.split("|").map((entry) => entry.trim()).filter(Boolean);
    for (const entry of mapEntries) {
      const [move, code] = entry.split(">");
      if (move && code && normalizeUci(move.trim()) === normalizedUci) {
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
    if (this.state.mode === "learning") {
      const expectedSide = getSideFromFen(expected._fen_before)
        || (this.chess && this.chess.turn() === "w" ? "white" : "black");
      const prompt = expected.learn_prompt ? expected.learn_prompt : "";
      this.setPromptForCurrentFen(prompt, { side: expectedSide });
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
    this.state.hintLevel = 0;
    this.state.hintActive = false;
  },
  stepMove(direction) {
    let moved = false;
    this.stopPendingActions();
    this.state.engineSessionId += 1;
    this.state.engineBusy = false;
    this.stopLiveAnalysis({ clearAllListeners: true });
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
        const ply = this.state.moveHistory.length;
        this.state.databaseTrace = (this.state.databaseTrace || []).filter((entry) => entry.ply <= ply);
        this.syncDatabaseModeForCurrentPosition();
      }
      moved = true;
    } else {
      const redoMove = this.state.redoMoves.pop();
      if (redoMove) {
        const move = applyMoveUCI(this.chess, redoMove);
        if (!move) {
          return;
        }
        this.playMoveSound(move);
        this.state.moveHistory.push(redoMove);
        if (this.state.mode === "game") {
          this.syncDatabaseModeForCurrentPosition();
        }
        moved = true;
      } else if (this.canAdvanceLearning()) {
        const expected = this.getExpectedNodeFromPlan();
        const move = expected ? applyMoveUCI(this.chess, expected.move_uci) : null;
        if (!move) {
          return;
        }
        this.playMoveSound(move);
        this.recordMove(expected.move_uci, move);
        this.syncCurrentDepthFromFen();
        this.state.revealStage = 0;
        this.state.wrongAttemptsForPly = 0;
        if (this.state.mode === "learning") {
          this.showLearningExplain(expected);
        }
        moved = true;
      }
    }
    if (!moved) {
      return;
    }
    if (this.state.mode === "learning" || this.state.mode === "practice") {
      this.updateTrainingPositionState();
    }
    this.board.position(this.chess.fen());
    this.queueLiveAnalysis();
    this.updateNavigationControls();
    this.updateLastMoveHighlight();
    this.clearHintHighlight();
    this.state.hintLevel = 0;
    this.state.hintActive = false;
    if (this.state.mode === "learning" || this.state.mode === "practice") {
      this.setLineStatus(this.getActiveLine());
    }
    if (this.state.mode === "learning") {
      this.state.suppressInlineLearnPromptSpeak = true;
      this.syncPromptChainForCurrentFen();
      if (direction > 0) {
        this.showLearningPromptForReviewedMove();
      } else {
        this.showLearningPrompt();
      }
      this.clearCoachOverride();
      this.state.suppressInlineLearnPromptSpeak = false;
      const turnSide = this.chess && this.chess.turn() === "w" ? "white" : "black";
      const sideForPrompt = direction > 0
        ? (turnSide === "white" ? "black" : "white")
        : turnSide;
      const chain = this.state.promptChainBySide[sideForPrompt];
      const promptToSpeak = (chain && chain.current) || "";
      if (promptToSpeak) {
        TTS.replay(promptToSpeak);
      }
    }
    this.setStatus("Reviewing moves.");
    this.adminHighlightActiveNode && this.adminHighlightActiveNode();
  },
  canAdvanceLearning() {
    if (this.state.mode !== "learning") {
      return false;
    }
    const expected = this.getExpectedNodeFromPlan();
    if (!expected) {
      return false;
    }
    return this.isMoveUciLegal(expected.move_uci);
  },
  isMoveUciLegal(uci) {
    if (!uci) {
      return false;
    }
    const normalizedUci = normalizeUci(uci);
    const moves = this.chess.moves({ verbose: true });
    return moves.some((move) => normalizeUci(moveToUci(move)) === normalizedUci);
  },
  updateTrainingPositionState() {
    const fenKey = normalizeFen(this.chess.fen());
    this.syncCurrentDepthFromFen();
    if (this.state.sessionPlan && !this.state.sessionPlan.expectedByFenKey[fenKey]) {
      this.state.outOfLine = true;
    } else {
      this.state.outOfLine = false;
    }
  },
  showLearningPrompt() {
    if (this.state.mode !== "learning") {
      return;
    }
    const expected = this.getExpectedNode();
    if (expected) {
      const expectedSide = getSideFromFen(expected._fen_before)
        || (this.chess && this.chess.turn() === "w" ? "white" : "black");
      const opponentSide = expectedSide === "white" ? "black" : "white";
      const prompt = expected.learn_prompt ? expected.learn_prompt : "";
      const fenKey = normalizeFen(this.chess.fen());
      const isInitialPosition = this.chess
        && this.chess.fen().startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR");
      if (isInitialPosition) {
        if (!this.state.promptHistoryByFenBySide[fenKey]) {
          this.state.promptHistoryByFenBySide[fenKey] = {};
        }
        this.state.promptHistoryByFenBySide[fenKey][opponentSide] = { current: "", previous: "" };
        this.state.promptChainBySide[opponentSide] = { current: "", previous: "" };
      } else {
        const historyBySide = this.state.promptHistoryByFenBySide[fenKey] || {};
        const opponentHistory = historyBySide[opponentSide];
        if (!opponentHistory || (!opponentHistory.current && !opponentHistory.previous)) {
          const plan = this.state.sessionPlan;
          const currentDepth = Number.isFinite(this.state.currentDepth) ? this.state.currentDepth : -1;
          const nextNodeKey = plan && plan.order ? plan.order[currentDepth + 1] : null;
          const nextNode = nextNodeKey ? this.data.nodesById[nextNodeKey] : null;
          const nextPrompt = nextNode && nextNode.learn_prompt ? nextNode.learn_prompt : "";
          this.setPromptForCurrentFen(nextPrompt, { side: opponentSide, suppressTTS: true });
        }
      }
      this.setPromptForCurrentFen(prompt, { side: expectedSide });
    }
  },
  showLearningPromptForReviewedMove() {
    if (this.state.mode !== "learning") {
      return;
    }
    const plan = this.state.sessionPlan;
    const currentDepth = Number.isFinite(this.state.currentDepth) ? this.state.currentDepth : -1;
    if (!plan || currentDepth <= 0) {
      this.showLearningPrompt();
      return;
    }
    const previousNodeKey = plan.order[currentDepth - 1];
    const previousNode = previousNodeKey ? this.data.nodesById[previousNodeKey] : null;
    if (!previousNode) {
      this.showLearningPrompt();
      return;
    }
    const previousSide = getSideFromFen(previousNode._fen_before)
      || (this.chess && this.chess.turn() === "w" ? "black" : "white");
    const prompt = previousNode.learn_prompt ? previousNode.learn_prompt : "";
    this.setPromptForCurrentFen(prompt, { side: previousSide });
  },
  showLearningExplain(row) {
    this.setCoachOverride("Good move. Continue.", { durationMs: 2000 });
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
  getExpectedHintSquare(row) {
    if (!row) {
      return null;
    }
    const uci = row.move_uci || "";
    if (uci.length >= 2) {
      const fromSquare = uci.slice(0, 2);
      if (this.chess.get(fromSquare)) {
        return fromSquare;
      }
    }
    const expectedSan = this.getExpectedSan(row);
    const moves = this.chess.moves({ verbose: true });
    let match = null;
    if (uci) {
      match = moves.find((move) => moveToUci(move) === uci) || null;
    }
    if (!match && expectedSan) {
      match = moves.find((move) => move.san === expectedSan) || null;
    }
    return match ? match.from : null;
  },
  handleHint() {
    const row = this.getExpectedNode();
    if (!row) {
      return;
    }
    const hintStep = this.state.hintLevel % 2;
    if (hintStep === 0) {
      const square = this.getExpectedHintSquare(row);
      if (square) {
        this.setHintHighlight(square);
        this.setComment("Hint: highlighted the piece to move.", { isHint: true });
      } else {
        this.setComment("Hint: focus on the expected move.", { isHint: true });
      }
      this.state.hintActive = true;
    } else {
      this.clearHintHighlight();
      const prompt = row.learn_prompt || "Find the next move.";
      this.setComment(`Hint: ${prompt}`, { isHint: true });
      this.state.hintActive = false;
    }
    this.state.hintLevel = (this.state.hintLevel + 1) % 2;
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
    if (this.state.outOfLine && !this.isLineCompletePosition()) {
      return;
    }
    if (this.isLineCompletePosition()) {
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
      `Cmp:${stats.completed || 0} Stu:${stats.learned || 0} Prf:${stats.perfect || 0} Reps:${reps} Ease:${ease}`
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
  getManualSelectionLines(lines) {
    return this.getFilteredLines(lines);
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
    const srData = loadSR();
    const sr = ensureSRDefaults(srData[getLineKey(openingId, line.line_id)]);
    const completed = sr.stats.completed || 0;
    const learned = sr.stats.learned || 0;
    const studyCount = completed + learned;
    return 1 / (1 + studyCount);
  },
  resolveSessionLine(forceStart) {
    const lines = this.data.linesByOpeningId[this.state.openingId] || [];
    const selection = this.state.lineId;
    let line = null;
    if (selection && selection !== "any") {
      line = lines.find((item) => item.line_id === selection) || null;
    }
    if (!line && forceStart && lines.length) {
      const pool = this.getFilteredLines(lines);
      line = this.pickWeightedDisplayLine(pool);
      if (line) {
        this.state.lineId = line.line_id;
        this.updateLineSelectionDisplay();
        this.updateSelectorThumbnails();
      }
    }
    this.state.sessionLineId = line ? line.line_id : null;
    return line;
  },
  getActiveLine() {
    if (this.state.sessionLineId) {
      return this.data.linesById[this.state.sessionLineId] || null;
    }
    const selection = this.state.lineId;
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
    const hasLearningAdvance = this.canAdvanceLearning();
    this.$next.prop("disabled", !(hasRedo || hasLearningAdvance));
  },
  setStatus(text) {
    this.state.statusText = text;
    this.renderCoachComment();
  },
  setComment(html, options = {}) {
    if (this.state.mode === "learning" && !options.isPrompt) {
      this.setCoachOverride(html, options);
      return;
    }
    const resolvedSide = normalizeDrillSide(options.side);
    // When no side is specified, associate the message with the side to move
    // so neutral feedback follows the active player instead of showing twice.
    const inferredSide = normalizeDrillSide(this.chess ? this.chess.turn() : this.state.userSide) || this.state.userSide;
    const side = resolvedSide || inferredSide;
    const history = this.state.coachCommentBySide[side] || { current: "", previous: "" };
    history.previous = history.current;
    history.current = html;
    this.state.coachCommentBySide[side] = history;
    if (!options.isHint) {
      this.state.lastCoachComment = html;
      this.state.hintActive = false;
    }
    this.renderCoachComment();
  },
  setCoachOverride(html, options = {}) {
    const { durationMs } = options;
    this.clearCoachOverride({ animate: false });
    this.state.coachOverride = html;
    this.state.coachOverrideActive = true;
    this.$comment
      .addClass("coach-override-enter")
      .removeClass("coach-override-exit");
    requestAnimationFrame(() => {
      this.$comment
        .addClass("coach-override-active")
        .removeClass("coach-override-enter");
    });
    if (durationMs) {
      this.state.coachOverrideTimer = setTimeout(() => {
        this.state.coachOverrideTimer = null;
        this.clearCoachOverride();
        this.renderCoachComment();
      }, durationMs);
    }
    this.renderCoachComment();
  },
  clearCoachOverride({ animate = true } = {}) {
    if (this.state.coachOverrideTimer) {
      clearTimeout(this.state.coachOverrideTimer);
      this.state.coachOverrideTimer = null;
    }
    this.state.coachOverride = null;
    this.state.coachOverrideActive = false;
    if (!animate) {
      this.$comment.removeClass("coach-override-active coach-override-enter coach-override-exit");
      return;
    }
    if (!this.$comment.hasClass("coach-override-active")) {
      this.$comment.removeClass("coach-override-enter coach-override-exit");
      return;
    }
    this.$comment.removeClass("coach-override-enter").addClass("coach-override-exit");
    setTimeout(() => {
      this.$comment.removeClass("coach-override-active coach-override-exit");
    }, 220);
  },
  getPromptHistoryForFen(fenKey, side) {
    const historyBySide = this.state.promptHistoryByFenBySide[fenKey];
    if (!historyBySide) {
      return { current: "", previous: "" };
    }
    return historyBySide[side] || { current: "", previous: "" };
  },
  setPromptForCurrentFen(prompt, options = {}) {
    const fenKey = normalizeFen(this.chess.fen());
    const resolvedSide = normalizeDrillSide(options.side);
    const inferredSide = normalizeDrillSide(this.chess ? this.chess.turn() : this.state.userSide) || this.state.userSide;
    const side = resolvedSide || inferredSide;
    const history = this.getPromptHistoryForFen(fenKey, side);
    const previousPrompt = (this.state.promptChainBySide[side] || {}).current || "";
    const promptChanged = history.current !== prompt;
    if (promptChanged) {
      history.previous = history.current || previousPrompt;
      history.current = prompt;
    } else if (previousPrompt && history.previous !== previousPrompt && history.current !== previousPrompt) {
      history.previous = previousPrompt;
    }
    if (!this.state.promptHistoryByFenBySide[fenKey]) {
      this.state.promptHistoryByFenBySide[fenKey] = {};
    }
    this.state.promptHistoryByFenBySide[fenKey][side] = history;
    this.state.promptChainBySide[side] = { current: history.current, previous: history.previous };
    this.renderCoachComment();
    if (
      this.state.mode === "learning"
      && prompt
      && promptChanged
      && !this.state.suppressInlineLearnPromptSpeak
      && !options.suppressTTS
    ) {
      TTS.queue(prompt);
    }
  },
  syncPromptChainForCurrentFen() {
    const fenKey = normalizeFen(this.chess.fen());
    const historyBySide = this.state.promptHistoryByFenBySide[fenKey] || {};
    ["white", "black"].forEach((side) => {
      const history = historyBySide[side];
      if (history) {
        this.state.promptChainBySide[side] = { current: history.current, previous: history.previous };
      } else {
        this.state.promptChainBySide[side] = { current: "", previous: "" };
      }
    });
  },
  renderCoachComment() {
    const override = this.state.coachOverride;
    const useLearningPrompts = this.state.mode === "learning";
    const studiedSide = this.state.userSide;
    const opponentSide = studiedSide === "white" ? "black" : "white";
    const useSideLabel = useLearningPrompts || this.state.mode === "practice";
    const winProbHtml = `
      <button class="win-probability-pill" id="winProbPill" type="button" aria-label="Win probability unavailable" aria-pressed="${this.state.analysisEnabled ? "true" : "false"}">
        <span class="win-probability" id="winProbText">${this.state.winProbText}</span>
      </button>
    `;
    const buildCoachMessage = (side) => {
      const promptChain = this.state.promptChainBySide[side] || { current: "", previous: "" };
      const fallback = this.state.coachCommentBySide[side] || { current: "", previous: "" };
      const promptCurrent = promptChain.current || "";
      const promptPrevious = promptChain.previous || "";
      const fallbackCurrent = fallback.current || "";
      const fallbackPrevious = fallback.previous || "";
      const sideOverride = override && side === studiedSide ? override : "";
      let base = sideOverride || fallbackCurrent;
      if (useLearningPrompts) {
        base = side === studiedSide
          ? promptCurrent
          : (promptPrevious || promptCurrent);
      }
      const previous = useLearningPrompts ? "" : fallbackPrevious;
      return { base, previous };
    };
    const buildRow = (side, rowClass) => {
      const sideEmoji = side === "black" ? "♟" : "♙";
      const prefix = useSideLabel ? `<span class="side-emoji" aria-hidden="true">${sideEmoji}</span> ` : "";
      const { base, previous } = buildCoachMessage(side);
      const plainBase = base.replace(/<[^>]*>/g, "").trim();
      const plainPrevious = previous.replace(/<[^>]*>/g, "").trim();
      if (!plainBase && !plainPrevious) {
        return "";
      }
      const currentHtml = plainBase
        ? `<div class="coach-message-current"><span class="coach-message-text">${prefix}${base}</span></div>`
        : "";
      const previousHtml = plainPrevious
        ? `<div class="coach-message-previous"><span class="coach-message-text">${prefix}${plainPrevious}</span></div>`
        : "";
      const contentHtml = (currentHtml || previousHtml)
        ? `<div class="coach-message-content">${currentHtml}${previousHtml}</div>`
        : `<div class="coach-message-content"></div>`;
      return `<div class="coach-message-row ${rowClass}">${contentHtml}</div>`;
    };
    const studiedRow = buildRow(studiedSide, "coach-message-studied");
    const opponentRow = buildRow(opponentSide, "coach-message-opponent");
    const hasOpponentRow = opponentRow.trim().length > 0;
    const hasStudiedRow = studiedRow.trim().length > 0;
    const isSinglePrompt = Number(hasOpponentRow) + Number(hasStudiedRow) === 1;
    this.$comment.toggleClass("single-prompt", isSinglePrompt);
    this.$comment.html(
      `<div class="coach-message-stack coach-message-fade">
        <div class="coach-message-meta-column">${winProbHtml}</div>
        <div class="coach-message-rows">${studiedRow}${opponentRow}</div>
      </div>`
    );
    this.$winProbText = this.$comment.find("#winProbText");
    this.$winProbPill = this.$comment.find("#winProbPill");
    this.updateWinProbPillState();
  },
  updateWinProbability(probability) {
    if (!Number.isFinite(probability)) {
      this.state.winProbValue = null;
      this.state.winProbText = "⭘";
    } else {
      const clamped = Math.min(Math.max(probability, 0), 1);
      this.state.winProbValue = clamped;
      this.state.winProbText = `${Math.round(clamped * 100)}`;
    }

    if (this.$winProbText && this.$winProbText.length) {
      this.$winProbText.text(this.state.winProbText);
    }
    this.updateWinProbPillState();
  },
  setWinProbSource(label, detail) {
    this.state.winProbSourceLabel = label || "";
    this.state.winProbSourceDetail = detail || "";
    this.updateWinProbPillState();
  },
  updateWinProbPillState() {
    if (!this.$winProbPill || !this.$winProbPill.length) {
      return;
    }
    const isEnabled = this.state.engineEnabled;
    const isActive = this.state.analysisEnabled;
    this.$winProbPill.prop("disabled", !isEnabled);
    this.$winProbPill.attr("aria-pressed", isActive ? "true" : "false");
    this.$winProbPill.attr("aria-label", this.buildWinProbAriaLabel());
  },
  buildWinProbAriaLabel() {
    if (!this.state.engineEnabled) {
      return "Win probability unavailable. Engine disabled.";
    }
    const status = this.state.analysisEnabled ? "Win probability analysis on." : "Win probability analysis off.";
    const value = this.state.winProbValue === null
      ? "White win probability unavailable."
      : `White win probability ${Math.round(this.state.winProbValue * 100)} percent.`;
    const sourceParts = [this.state.winProbSourceLabel, this.state.winProbSourceDetail].filter(Boolean);
    const source = sourceParts.length ? `Source: ${sourceParts.join(" ")}.` : "";
    return `${status} ${value} ${source}`.trim();
  },
  toggleWinProbAnalysis() {
    if (!this.state.engineEnabled) {
      return;
    }
    this.state.analysisEnabled = !this.state.analysisEnabled;
    if (this.state.analysisEnabled) {
      this.updateWinProbability(null);
      this.setWinProbSource("Stockfish", "Depth 0");
      this.queueLiveAnalysis({ delayMs: 0 });
    } else {
      this.stopLiveAnalysis({ clearAllListeners: true });
      this.updateWinProbability(null);
      this.setWinProbSource("", "");
    }
    this.updateWinProbPillState();
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
  getNodesForFenKey(fenKey) {
    const keys = (this.data.nodesByFen || {})[fenKey] || [];
    return keys.map((key) => this.data.nodesById[key]).filter(Boolean);
  },
  getCandidateNodesForFen(openingId, fenKey, mode, currentLineId) {
    const candidates = this.getNodesForOpeningFenKey(openingId, fenKey);
    if (mode === "learning" || mode === "practice") {
      if (!currentLineId) {
        return [];
      }
      return candidates.filter((candidate) => candidate.line_id === currentLineId);
    }
    return candidates;
  },
  getCandidateNodesForCurrentFen() {
    const normalized = normalizeFen(this.chess.fen());
    return this.getNodesForOpeningFenKey(this.state.openingId, normalized);
  },
  getDatabaseCandidatesForFenKey(fenKey) {
    const normalized = normalizeFen(fenKey);
    if (!normalized) {
      return [];
    }
    const openingCandidates = this.getNodesForOpeningFenKey(this.state.openingId, normalized);
    if (openingCandidates.length) {
      return openingCandidates;
    }
    return this.getNodesForFenKey(normalized);
  },
  getDatabaseCandidatesForCurrentFen() {
    return this.getDatabaseCandidatesForFenKey(normalizeFen(this.chess.fen()));
  },
  syncDatabaseModeForCurrentPosition() {
    const known = this.getDatabaseCandidatesForCurrentFen().length > 0;
    this.state.inBook = known;
    if (this.state.mode === "game" && known) {
      this.stopLiveAnalysis();
      this.$engineEval.text("");
      this.updateWinProbability(null);
      this.setWinProbSource("Database", "Known position");
    }
    return known;
  },
  shouldUseEngineForCurrentPosition() {
    return !(this.state.mode === "game" && this.getDatabaseCandidatesForCurrentFen().length > 0);
  },
  recordDatabaseTrace(node, move, actor, fenBefore) {
    if (!node || this.state.mode !== "game") {
      return;
    }
    const line = this.data.linesById[node.line_id] || {};
    const opening = this.data.openingsById[node.opening_id] || {};
    this.state.databaseTrace.push({
      ply: this.state.moveHistory.length,
      actor,
      opening_id: node.opening_id || "",
      opening_name: opening.opening_name || node.opening_id || "",
      line_id: node.line_id || "",
      line_name: line.line_name || node.line_id || "",
      node_id: node.node_id || "",
      fen_key: node._fen_key || node.fen_key || normalizeFen(fenBefore || ""),
      fen_before: node._fen_before || node.fen_before || fenBefore || "",
      move_uci: normalizeUci(node.move_uci),
      san: move && move.san ? move.san : (node._san || "")
    });
  },
  showDatabaseTraceSummary() {
    const trace = this.state.databaseTrace || [];
    if (!trace.length) {
      this.setComment("No database positions were matched in this game.");
      return;
    }
    const lineMap = {};
    trace.forEach((entry) => {
      const key = entry.line_id || "(unknown)";
      if (!lineMap[key]) {
        lineMap[key] = {
          lineName: entry.line_name || key,
          openingName: entry.opening_name || entry.opening_id || "Opening",
          plies: 0,
          positions: new Set()
        };
      }
      lineMap[key].plies += 1;
      if (entry.fen_key) {
        lineMap[key].positions.add(entry.fen_key);
      }
    });
    const lines = Object.values(lineMap)
      .sort((a, b) => b.plies - a.plies || a.lineName.localeCompare(b.lineName))
      .slice(0, 5);
    const items = lines.map((entry) =>
      `<li><strong>${escapeHtml(entry.lineName)}</strong> (${escapeHtml(entry.openingName)}): ${entry.plies} move${entry.plies === 1 ? "" : "s"}, ${entry.positions.size} position${entry.positions.size === 1 ? "" : "s"}</li>`
    ).join("");
    this.setComment(`<p>Database positions tracked: ${trace.length} move${trace.length === 1 ? "" : "s"}.</p><ul>${items}</ul>`);
  },
  pickBestCandidate(candidates, preferredLineId) {
    if (!candidates.length) {
      return null;
    }
    const preferred = preferredLineId
      ? candidates.filter((candidate) => candidate.line_id === preferredLineId)
      : [];
    const pool = preferred.length ? preferred : candidates;
    return pool[Math.floor(Math.random() * pool.length)];
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
      this.state.outOfLine = false;
      return expected;
    }
    if (this.state.mode === "learning" || this.state.mode === "practice") {
      const fenKey = normalizeFen(this.chess.fen());
      const plan = this.state.sessionPlan;
      if (plan && !plan.expectedByFenKey[fenKey] && !this.isLineCompletePosition()) {
        this.state.outOfLine = true;
        this.setStatus("Out of this line. Use Undo or Resume-from-FEN to continue.");
      }
      return null;
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
  pickDatabaseNode(candidates) {
    if (!candidates.length) {
      return null;
    }
    return this.pickBestCandidate(candidates, this.state.sessionLineId);
  },
  isMoveInOtherLine(fenKey, uci, currentLineId) {
    const candidates = this.getNodesForOpeningFenKey(this.state.openingId, fenKey);
    const normalizedUci = normalizeUci(uci);
    return candidates.some((node) => normalizeUci(node.move_uci) === normalizedUci && node.line_id !== currentLineId);
  },
  isLineCompletePosition() {
    const plan = this.state.sessionPlan;
    if (!plan || !plan.order.length) {
      return false;
    }
    if (this.state.moveHistory.length < plan.totalPlies) {
      return false;
    }
    const lastNodeKey = plan.order[plan.order.length - 1];
    const lastNode = this.data.nodesById[lastNodeKey];
    if (!lastNode) {
      return false;
    }
    const lastMove = this.state.moveHistory[this.state.moveHistory.length - 1];
    return lastMove === lastNode.move_uci;
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
  queueLiveAnalysis(options = {}) {
    const { delayMs = 75 } = options;
    if (!this.state.engineEnabled || !this.state.analysisEnabled) {
      return;
    }
    if (!this.shouldUseEngineForCurrentPosition()) {
      this.syncDatabaseModeForCurrentPosition();
      return;
    }
    if (this.state.pendingAnalysisTimer) {
      clearTimeout(this.state.pendingAnalysisTimer);
    }
    this.state.pendingAnalysisTimer = setTimeout(() => {
      this.state.pendingAnalysisTimer = null;
      this.restartLiveAnalysis();
    }, delayMs);
  },
  startLiveAnalysis() {
    if (!this.state.engineEnabled || !this.state.analysisEnabled) {
      return;
    }
    if (!this.shouldUseEngineForCurrentPosition()) {
      this.syncDatabaseModeForCurrentPosition();
      return;
    }
    this.ensureEngine();
    if (!this.engine) {
      return;
    }
    if (this.state.mode !== "game") {
      this.$engineEval.text("");
    }
    const fen = this.chess.fen();
    const maxDepth = 24;
    const buildInfoHandler = (getToken) => (evalText, evalData) => {
      if (!this.state.analysisActive || this.state.analysisFen !== fen) {
        return;
      }
      if (getToken() !== this.state.analysisSessionId) {
        return;
      }
      if (this.state.mode === "game") {
        this.$engineEval.text(evalText);
      }
      if (evalData) {
        const winProb = calculateWinProbability(evalData);
        this.updateWinProbability(winProb);
        const depthLabel = Number.isFinite(evalData.depth) ? `Depth ${evalData.depth}` : "";
        this.setWinProbSource("Stockfish", depthLabel);
        if (Number.isFinite(evalData.depth) && evalData.depth >= maxDepth) {
          this.stopLiveAnalysis();
        }
      }
    };
    if (this.state.analysisActive && this.state.analysisFen === fen) {
      if (!this.engine.analysisListener) {
        let analysisToken = 0;
        const handler = buildInfoHandler(() => analysisToken);
        analysisToken = this.engine.startAnalysis(fen, handler);
        this.state.analysisSessionId = analysisToken;
      }
      return;
    }

    // Position changed: clear stale value immediately while fresh analysis starts.
    this.updateWinProbability(null);
    this.setWinProbSource("Stockfish", "Depth 0");

    this.state.analysisFen = fen;
    this.state.analysisActive = true;
    let analysisToken = 0;
    const handler = buildInfoHandler(() => analysisToken);
    analysisToken = this.engine.startAnalysis(fen, handler);
    this.state.analysisSessionId = analysisToken;
  },
  stopLiveAnalysis(options = {}) {
    const { clearAllListeners = false } = options;
    if (this.engine) {
      this.engine.stopAnalysis(clearAllListeners);
    }
    this.state.analysisActive = false;
    this.state.analysisFen = null;
    this.state.analysisSessionId = 0;
  },
  restartLiveAnalysis() {
    this.stopLiveAnalysis();
    this.startLiveAnalysis();
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
    this.analysisToken = 0;
    this.lastDepth = null;
    this.lastScore = null;
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
    // Ask Stockfish for WDL triplets so win probability can come directly
    // from engine output when available.
    this.send("setoption name UCI_ShowWDL value true");
    this.send("isready");
  }

  send(message) {
    if (this.worker) {
      this.worker.postMessage(message);
    }
  }

  resetInfoState() {
    this.lastDepth = null;
    this.lastScore = null;
  }

  clearAllListeners() {
    this.pending = [];
    this.listeners = [];
    this.analysisListener = null;
    this.resetInfoState();
  }

  shouldEmitInfo(evalData) {
    const firstInfo = this.lastDepth === null;
    const depthOk = Number.isFinite(evalData.depth) && evalData.depth >= 6;
    let stableOk = false;
    if (this.lastScore) {
      if (evalData.type === "cp" && this.lastScore.type === "cp") {
        stableOk = Math.abs(evalData.value - this.lastScore.value) <= 0.1;
      } else if (evalData.type === "mate" && this.lastScore.type === "mate") {
        stableOk = evalData.value === this.lastScore.value;
      }
    }
    this.lastScore = { type: evalData.type, value: evalData.value };
    if (Number.isFinite(evalData.depth)) {
      this.lastDepth = evalData.depth;
    }
    return firstInfo || depthOk || stableOk;
  }

  startAnalysis(fen, onInfo) {
    this.stopAnalysis();
    this.resetInfoState();
    this.analysisToken += 1;
    const analysisToken = this.analysisToken;
    const listener = (text) => {
      if (analysisToken !== this.analysisToken) {
        return;
      }
      if (text.startsWith("info") && onInfo) {
        const evalData = parseEvalData(text, fen, "white");
        if (evalData && this.shouldEmitInfo(evalData)) {
          const evalText = formatEvalText(evalData);
          onInfo(evalText, evalData);
        }
      }
    };
    this.analysisListener = listener;
    this.listeners.push(listener);
    this.send(`position fen ${fen}`);
    this.send("go infinite");
    return analysisToken;
  }

  stopAnalysis(clearAll = false) {
    if (clearAll) {
      this.clearAllListeners();
    } else if (this.analysisListener) {
      this.listeners = this.listeners.filter((item) => item !== this.analysisListener);
      this.analysisListener = null;
    }
    this.analysisToken += 1;
    this.send("stop");
  }

  getBestMove(fen, movetime, onBestmove, onInfo) {
    this.stopAnalysis();
    this.resetInfoState();
    const listener = (text) => {
      if (text.startsWith("info") && onInfo) {
        const evalData = parseEvalData(text, fen, "white");
        if (evalData && this.shouldEmitInfo(evalData)) {
          const evalText = formatEvalText(evalData);
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

function isTrue(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function isPublished(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return normalized === "true" || normalized === "yes" || normalized === "1";
}

function normalizeUci(uci) {
  if (!uci) {
    return "";
  }
  let normalized = String(uci).trim().toLowerCase();
  normalized = normalized.replace(/[+#?!]+$/g, "");
  normalized = normalized.replace(/=([qrbn])$/i, "$1");
  return normalized;
}

function applyMoveUCI(chess, uci) {
  const normalized = normalizeUci(uci);
  if (!normalized || normalized.length < 4) {
    return null;
  }
  const move = {
    from: normalized.slice(0, 2),
    to: normalized.slice(2, 4)
  };
  if (normalized.length > 4 && /[qrbn]/.test(normalized[4])) {
    move.promotion = normalized[4];
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

function slugifyId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeOpeningNameKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadPinnedLines() {
  try {
    const raw = window.localStorage.getItem(PINNED_LINES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function safeLocalStorageGet(key) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch (error) {
    return "";
  }
}

function safeLocalStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    // Storage may be disabled; the setting just won't persist.
  }
}

function loadSuggestionDrafts() {
  try {
    const raw = window.localStorage.getItem(SUGGESTION_DRAFTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function saveSuggestionDrafts(drafts) {
  try {
    window.localStorage.setItem(SUGGESTION_DRAFTS_KEY, JSON.stringify(Array.isArray(drafts) ? drafts : []));
  } catch (error) {
    // Draft storage is best-effort.
  }
}

function compactText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!limit || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function savePinnedLines(map) {
  try {
    window.localStorage.setItem(PINNED_LINES_KEY, JSON.stringify(map || {}));
  } catch (error) {
    // Storage may be disabled; pins simply won't persist.
  }
}

function tokenizeMoveText(text) {
  let cleaned = String(text || "");
  cleaned = cleaned.replace(/^\s*\[[^\]]+\]\s*$/gm, " ");
  cleaned = cleaned.replace(/\{[^}]*\}/g, " ");
  cleaned = cleaned.replace(/;[^\n\r]*/g, " ");
  let previous = "";
  while (previous !== cleaned) {
    previous = cleaned;
    cleaned = cleaned.replace(/\([^()]*\)/g, " ");
  }
  return cleaned
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.replace(/^\d+\.(\.\.)?/, ""))
    .filter((token) => token && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token) && !token.startsWith("$"));
}

function parseStudyLineMoves(movesText, notation, startFen) {
  const tokens = tokenizeMoveText(movesText);
  if (!tokens.length) {
    throw new Error("No moves found.");
  }
  const uciPattern = /^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/;
  const resolvedNotation = notation === "auto"
    ? (tokens.every((token) => uciPattern.test(token.replace("=", ""))) ? "uci" : "san")
    : notation;
  const chess = new Chess();
  if (!loadFenForChess(chess, startFen)) {
    throw new Error("Start FEN is invalid.");
  }
  const moves = [];
  tokens.forEach((token) => {
    const fenBefore = chess.fen();
    const fenParts = fenBefore.split(/\s+/);
    const color = fenParts[1] === "b" ? "black" : "white";
    const moveNumber = parseInt(fenParts[5] || "1", 10) || 1;
    let move = null;
    if (resolvedNotation === "uci") {
      move = applyMoveUCI(chess, token);
    } else {
      move = chess.move(token.replace(/[?!]+$/g, ""), { sloppy: true });
    }
    if (!move) {
      throw new Error(`Illegal or unreadable move: ${token}`);
    }
    const fenAfter = chess.fen();
    moves.push({
      uci: moveToUci(move),
      san: move.san,
      color,
      moveNumber,
      fenBefore,
      fenKey: normalizeFen(fenBefore),
      fenAfter,
      fenAfterKey: normalizeFen(fenAfter)
    });
  });
  return {
    notation: resolvedNotation,
    moves,
    movesPgn: formatSanMoves(moves)
  };
}

function formatSanMoves(moves) {
  const parts = [];
  moves.forEach((move, index) => {
    const previous = moves[index - 1];
    if (move.color === "white") {
      parts.push(`${move.moveNumber}.`);
      parts.push(move.san);
    } else {
      if (!previous || previous.color !== "white" || previous.moveNumber !== move.moveNumber) {
        parts.push(`${move.moveNumber}...`);
      }
      parts.push(move.san);
    }
  });
  return parts.join(" ");
}

function objectToRow(obj, headers) {
  return headers.map((header) => obj[header] || "");
}

function rowsToTsv(rows) {
  return rows
    .map((row) => row.map((cell) => formatTsvCell(cell)).join("\t"))
    .join("\n");
}

function formatTsvCell(value) {
  const text = String(value === undefined || value === null ? "" : value);
  if (/["\t\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function padFenFields(fen) {
  const parts = String(fen || "").trim().split(/\s+/);
  if (parts.length === 4) {
    parts.push("0", "1");
  } else if (parts.length === 5) {
    parts.push("1");
  }
  return parts.join(" ");
}

function extractFenFromInput(raw) {
  const lines = String(raw || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    return "";
  }
  const candidate = lines[0].replace(/^fen[:\s]+/i, "").trim();
  const fenPattern = /^([pnbrqkPNBRQK1-8]+\/){7}[pnbrqkPNBRQK1-8]+\s+[wb]\s+[KQkqA-Ha-h-]+\s+(-|[a-h][1-8])(\s+\d+\s+\d+)?$/;
  return fenPattern.test(candidate) ? candidate : "";
}

function describeChessComResult(raw) {
  if (!raw) {
    return "";
  }
  if (raw === "win") {
    return "Won";
  }
  const drawResults = ["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"];
  if (drawResults.includes(raw)) {
    return "Draw";
  }
  return "Lost";
}

function fetchChessComGames(username) {
  const trimmed = username.trim();
  const lowerUser = trimmed.toLowerCase();
  const encodedUser = encodeURIComponent(trimmed);
  return fetch(`https://api.chess.com/pub/player/${encodedUser}/games/archives`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Player not found on Chess.com."))))
    .then((data) => {
      const archives = data.archives || [];
      if (!archives.length) {
        return [];
      }
      const lastUrl = archives[archives.length - 1];
      return fetch(lastUrl)
        .then((res) => (res.ok ? res.json() : { games: [] }))
        .then((page) => {
          const games = page.games || [];
          if (games.length >= 10 || archives.length < 2) {
            return games;
          }
          const prevUrl = archives[archives.length - 2];
          return fetch(prevUrl)
            .then((res) => (res.ok ? res.json() : { games: [] }))
            .then((prevPage) => games.concat(prevPage.games || []));
        });
    })
    .then((games) => {
      games.sort((a, b) => (b.end_time || 0) - (a.end_time || 0));
      return games.slice(0, 15).map((game) => {
        const whiteName = (game.white && game.white.username) || "?";
        const blackName = (game.black && game.black.username) || "?";
        const userSide = whiteName.toLowerCase() === lowerUser ? "white" : (blackName.toLowerCase() === lowerUser ? "black" : "");
        const rawResult = userSide === "white" ? (game.white && game.white.result) : userSide === "black" ? (game.black && game.black.result) : "";
        return {
          pgn: game.pgn || "",
          white: whiteName,
          black: blackName,
          userSide,
          resultLabel: describeChessComResult(rawResult),
          date: game.end_time ? new Date(game.end_time * 1000) : null,
          timeClass: game.time_class || ""
        };
      });
    });
}

function fetchLichessGames(username) {
  const trimmed = username.trim();
  const lowerUser = trimmed.toLowerCase();
  const encodedUser = encodeURIComponent(trimmed);
  const url = `https://lichess.org/api/games/user/${encodedUser}?max=15&sort=dateDesc`;
  return fetch(url, { headers: { Accept: "application/x-ndjson" } })
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error("Player not found on Lichess."))))
    .then((text) => {
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      return lines.map((line) => {
        const game = JSON.parse(line);
        const whiteUser = game.players && game.players.white && game.players.white.user;
        const blackUser = game.players && game.players.black && game.players.black.user;
        const whiteName = whiteUser ? whiteUser.name : "AI";
        const blackName = blackUser ? blackUser.name : "AI";
        const userSide = whiteName.toLowerCase() === lowerUser ? "white" : (blackName.toLowerCase() === lowerUser ? "black" : "");
        let resultLabel = "";
        if (game.status === "draw" || game.status === "stalemate") {
          resultLabel = "Draw";
        } else if (game.winner && userSide) {
          resultLabel = game.winner === userSide ? "Won" : "Lost";
        }
        return {
          moves: game.moves || "",
          white: whiteName,
          black: blackName,
          userSide,
          resultLabel,
          date: game.createdAt ? new Date(game.createdAt) : null,
          timeClass: game.speed || game.perf || ""
        };
      });
    });
}

function getSideFromFen(fen) {
  if (!fen) {
    return "";
  }
  const parts = fen.trim().split(" ");
  if (parts.length < 2) {
    return "";
  }
  if (parts[1] === "w") {
    return "white";
  }
  if (parts[1] === "b") {
    return "black";
  }
  return "";
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

function formatSideLabel(value) {
  const side = normalizeDrillSide(value);
  if (!side) {
    return "";
  }
  return side.charAt(0).toUpperCase() + side.slice(1);
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
  const evalData = parseEvalData(text, fen, "white");
  if (!evalData) {
    return "";
  }
  return formatEvalText(evalData);
}

function cpToLichessWinProbability(cp) {
  if (!Number.isFinite(cp)) {
    return null;
  }
  // Lichess-style centipawn -> winning-chances conversion.
  // Source shape: 1 / (1 + e^(-k*cp)), with k ~= 0.00368208.
  const clampedCp = Math.max(-1000, Math.min(1000, cp));
  const probability = 1 / (1 + Math.exp(-0.00368208 * clampedCp));
  return Math.max(0, Math.min(1, probability));
}

function calculateWinProbability(evalData) {
  if (!evalData) {
    return null;
  }

  if (evalData.type === "mate") {
    return evalData.value > 0 ? 1 : 0;
  }

  // Primary: cp-based win chances (aligned with Lichess behavior).
  const cp = Number.isFinite(evalData.cp)
    ? evalData.cp
    : (Number.isFinite(evalData.value) ? Math.round(evalData.value * 100) : null);
  const cpWinProb = cpToLichessWinProbability(cp);
  if (Number.isFinite(cpWinProb)) {
    return cpWinProb;
  }

  // Fallback: Stockfish WDL expected score if cp is unavailable.
  if (Number.isFinite(evalData.winProb)) {
    return Math.max(0, Math.min(1, evalData.winProb));
  }

  return null;
}

function parseEvalData(text, fen, perspective = "white") {
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

  // UCI score is from side-to-move perspective; convert to requested perspective.
  const turn = fen.split(" ")[1];
  const turnSide = turn === "b" ? "black" : "white";
  const adjusted = perspective === turnSide ? rawValue : -rawValue;

  const depthMatch = text.match(/depth (\d+)/);
  const nodesMatch = text.match(/nodes (\d+)/);
  const depth = depthMatch ? parseInt(depthMatch[1], 10) : null;
  const nodes = nodesMatch ? parseInt(nodesMatch[1], 10) : null;

  let winProb = null;
  const wdlMatch = text.match(/\bwdl\s+(\d+)\s+(\d+)\s+(\d+)/);
  if (wdlMatch) {
    const w = parseInt(wdlMatch[1], 10);
    const d = parseInt(wdlMatch[2], 10);
    const l = parseInt(wdlMatch[3], 10);
    const total = w + d + l;
    if (total > 0) {
      // Use expected-score style probability (win + 0.5*draw), which keeps
      // balanced starting positions near 50 instead of very low values.
      const sideToMoveScore = (w + 0.5 * d) / total;
      const opponentScore = (l + 0.5 * d) / total;
      winProb = perspective === turnSide ? sideToMoveScore : opponentScore;
    }
  }

  if (type === "mate") {
    return {
      type,
      value: adjusted,
      cp: adjusted,
      depth,
      nodes,
      winProb
    };
  }
  return {
    type,
    value: adjusted / 100,
    cp: adjusted,
    depth,
    nodes,
    winProb
  };
}

function formatEvalText(evalData) {
  if (!evalData) {
    return "";
  }
  if (evalData.type === "mate") {
    const mateText = evalData.value > 0
      ? Math.abs(evalData.value)
      : `-${Math.abs(evalData.value)}`;
    return `Engine eval: #${mateText}`;
  }
  return `Engine eval: ${evalData.value.toFixed(2)}`;
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
