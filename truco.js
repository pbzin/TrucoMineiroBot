// ==UserScript==
// @name         Trucoon - Assistente de Truco QA
// @namespace    trucoon-qa
// @version      7.8.5
// @description  Assistente compacto (compatível com Violentmonkey e Tampermonkey) com ciclo de rodada confiável, truco e placar sincronizados
// @match        https://trucoon.com.br/jogo/
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==
(function () {
    "use strict";

    // Tampermonkey/Violentmonkey executam em sandbox no Firefox. Os objetos
    // criados pelo jogo (inclusive `con`) ficam na janela da pagina.
    const PageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    const APP_KEY = "__TRUCO_QA_V5__";

    if (window[APP_KEY]) {
        console.warn("[QA Truco] Instância já inicializada; ignorando execução duplicada.");
        return;
    }

    const RingBuffer = {
        push(array, item, maxSize) {
            array.push(item);
            if (array.length > maxSize) array.splice(0, array.length - maxSize);
        },
    };

    // =====================
    // CONFIG
    // =====================
    const RuntimeConfig = {
        partnerWaitMs: 4500,
        criticalTimePercent: 20,
        limiteTrucoInicial: 70,
        limiteMao10Inicial: 50,
    };
    PageWindow.TrucoQAConfig = RuntimeConfig;

    const Config = Object.freeze({
        appName: "Truco QA",
        version: "7.8.5",
        selectors: {
            mesa: ".mesa",
            allCards: ".carta",
            tableCards: ".cartaMesa",
            turnedCard: ".cartaVirada, .carta1",
            ignoredHandAncestors: ".cartasBotoesContainer",
            popupMao10: "#popupMaode",
            popupJogo: "#popupJogo",
            popupTruco: "#popupTrucar",
            popupTrucoAceitar: "#trucoAceitarPopup",
            popupTrucoCorrer: "#trucoCorrerPopup",
            popupTrucoAumentar: "#trucoAumentarPopup",
            popupTrucoAjude: "#popupTrucar .botoes.ajude",
            parceiroOpiniao: "#parceiroOpniao",
            placarNos: ".time1 .pontosDuplas",
            placarEles: ".time2 .pontosDuplas",
            barraTempo: ".barraTempo div",
            tentos: ".tentos",
            meuJogador: "#jogador0",
            meuAvatar: "#jogador0 .foto.vermelho, #jogador0 .foto.roxo",
            parceiroAvatar: "#jogador2 .foto",
            jogadoresMesa: ".mesa > .jogador",
            time1Span: ".time1 span",
            time2Span: ".time2 span",
            pontosTime1: ".pontos .time1 .atv",
            pontosTime2: ".pontos .time2 .atv",
            pontosTime1Spans: ".pontos .time1 span",
            pontosTime2Spans: ".pontos .time2 span",
            tentosAtv: ".tentos .atv",
            tentosSemAtv: ".tentos .sematv",
            jogadorDiv: ".jogador .foto",
        },
        cardSprite: {
            width: 80,
            expectedBackgroundSize: "1044px 558px",
            suitRows: [0, -112, -224, -334],
            // A folha do Trucoon usa as linhas p/e/o/c: paus, espadas,
            // ouros e copas. A ordem anterior invertia espadas e ouros.
            suits: ["♣", "♠", "♦", "♥"],
            suitCodes: ["p", "e", "o", "c"],
            names: ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"],
            values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
            trucoMineiroRank: ["4", "5", "6", "7", "Q", "J", "K", "A", "2", "3"],
            trucoMineiroManilhas: [
                { nome: "7", naipe: "♦", apelido: "Sete de Ouros" },
                { nome: "A", naipe: "♠", apelido: "Espadilha" },
                { nome: "7", naipe: "♥", apelido: "Sete de Copas" },
                { nome: "4", naipe: "♣", apelido: "Zap" },
            ],
        },
        timings: {
            bootRetryMs: 500,
            debounceMs: 100,
            autoPlayCooldownMs: 2000,
            actionRetryMs: 3000,
            autoAnalyzeIntervalMs: 2000,
        },
        ids: {
            wrapper: "truco-panel-wrapper",
            panel: "truco-panel",
            header: "truco-panel-header",
            content: "truco-panel-conteudo",
            analysis: "truco-analise",
            suggestion: "truco-sugestao",
            status: "truco-status",
            minimize: "truco-btn-minimizar",
            close: "truco-btn-fechar",
            truco: "truco-btn-truco",
            accept: "truco-btn-aceitar",
            run: "truco-btn-correr",
            turn: "truco-btn-virar",
            mao10Jogar: "truco-btn-mao10-jogar",
            mao10Correr: "truco-btn-mao10-correr",
            reset: "truco-btn-zerar",
            autoAnalyze: "truco-auto-analisar",
            autoPlay: "truco-auto-jogar",
        },
        actionButtonIds: {
            truco: ["trucoAumentar"],
            accept: ["trucoAceitarPopup", "maoDezAceitar"],
            run: ["trucoCorrerPopup", "maoDezCorrer"],
            turn: ["acoesCartaVirada"],
            mao10Jogar: ["maoDezAceitar"],
            mao10Correr: ["maoDezCorrer"],
        },
        nativeMessages: {
            truco: { code: 27, payload: {} },
            accept: { code: 28, payload: {} },
            run: { code: 29, payload: {} },
            mao10Jogar: { code: 32, payload: { opiniao: true } },
            mao10Correr: { code: 32, payload: { opiniao: false } },
        },
        placarLimits: {
            maxTentos: 12,
            vantagemParaNaoArriscar: 8,
            desvantagemParaArriscar: 6,
        },
        // No Mineiro do Trucoon, "seis" vale 8 pontos e "nove" vale 10.
        trucoSequence: [2, 4, 8, 10, 12],
        timeColors: {
            vermelho: "rgb(204, 0, 41)",
            roxo: "rgb(88, 58, 139)",
        },
    });

    // =====================
    // TRUCO STATE MONITOR
    // =====================
    const TrucoState = {
        valor: 2,
        quemPediu: null,
        aguardandoResposta: false,
        paraParceiro: false,
        respondida: false,
        recebidoEm: 0,

        reset() {
            this.valor = 2;
            this.quemPediu = null;
            this.aguardandoResposta = false;
            this.paraParceiro = false;
            this.respondida = false;
            this.recebidoEm = 0;
        },

        pedir(valor) {
            this.valor = valor;
            this.quemPediu = 'eu';
            this.aguardandoResposta = true;
            this.respondida = false;
            this.recebidoEm = 0;
        },

        receberPedido(valor) {
            this.valor = valor;
            this.quemPediu = 'eles';
            this.aguardandoResposta = true;
            this.respondida = false;
            this.recebidoEm = Date.now();
        },

        pedidoFoiParaParceiro() {
            const destino = Utils.$("#popupTrucar #jogadorDir .nome")?.textContent?.trim();
            const meuNome = (Utils.$("#jogador0 .nome") || Utils.$("#jogadorNick0"))
                ?.textContent?.trim();
            if (destino && meuNome) return destino !== meuNome;
            const opiniao = Utils.$(Config.selectors.popupTrucoAjude);
            return Boolean(opiniao && Utils.isVisible(opiniao));
        },

        pedidoFoiParaNossaDupla() {
            const destino = Utils.$("#popupTrucar #jogadorDir .nome")?.textContent?.trim();
            const meuNome = (Utils.$("#jogador0 .nome") || Utils.$("#jogadorNick0"))
                ?.textContent?.trim();
            const parceiroNome = (Utils.$("#jogador2 .nome") || Utils.$("#jogadorNick2"))
                ?.textContent?.trim();
            if (destino && (meuNome || parceiroNome)) {
                return destino === meuNome || destino === parceiroNome;
            }
            return [Config.selectors.popupTrucoAceitar, Config.selectors.popupTrucoCorrer]
                .some(selector => Utils.isVisible(Utils.$(selector)));
        },

        aceitar() {
            this.aguardandoResposta = false;
            this.respondida = true;
        },

        correr() {
            this.aguardandoResposta = false;
            this.respondida = true;
            this.paraParceiro = false;
        },

        isEmTruco() {
            return this.valor > Config.trucoSequence[0] && this.aguardandoResposta;
        },

        getValorText() {
            if (this.valor >= 12) return 'Doze';
            if (this.valor >= 10) return 'Nove';
            if (this.valor >= 8) return 'Seis';
            if (this.valor >= 4) return 'Truco';
            return 'Normal';
        },

        getValorPontos() {
            return this.valor;
        },
    };

    // =====================
    // MAO DE 10 STATE
    // =====================
    const Mao10State = {
        ativa: false,
        cartasParceiro: [],
        cartasMinhas: [],
        planejamentoParceiro: [],
        planejamentoMinhas: [],

        abrir(cartasParceiro, cartasMinhas) {
            this.ativa = true;
            this.cartasParceiro = cartasParceiro || [];
            this.cartasMinhas = cartasMinhas || [];
            this.planejamentoParceiro = this.cartasParceiro.slice();
            this.planejamentoMinhas = this.cartasMinhas.slice();
        },

        fechar() {
            this.ativa = false;
            this.cartasParceiro = [];
            this.cartasMinhas = [];
        },

        reset() {
            this.fechar();
            this.planejamentoParceiro = [];
            this.planejamentoMinhas = [];
        },

        isAtiva() {
            // Verificar se o popup ainda está visível
            const popup = document.querySelector(Config.selectors.popupMao10);
            if (!popup || popup.style.display === 'none') {
                this.fechar();
                return false;
            }
            return this.ativa;
        },
    };

    // =====================
    // MEMORY TRACKER (🆕 memória de cartas já vistas na mão atual)
    // Acumula cartas que passaram pela mesa/virada durante a mão inteira,
    // mesmo depois que o DOM as remove ao trocar de rodada. Isso reduz o
    // "desconhecido" usado pelo ProbabilityAnalyzer e deixa a estimativa
    // de chance de vitória mais precisa a cada rodada jogada.
    // =====================
    const MemoryTracker = {
        seen: new Set(),
        reset() {
            this.seen.clear();
        },
        registrar(cards) {
            (cards || []).forEach(c => {
                if (c && c.nome && c.naipe) this.seen.add(`${c.nome}${c.naipe}`);
            });
        },
    };

    // =====================
    // DATASET COLLECTOR
    // =====================
    const DatasetCollector = {
        storageKey: "__TRUCO_QA_DATASET_V1__",
        maxEntries: 800,
        entries: [],
        lastSignature: null,
        init() {
            try {
                const raw = PageWindow.localStorage?.getItem(this.storageKey);
                const saved = raw ? JSON.parse(raw) : [];
                if (Array.isArray(saved)) this.entries = saved.slice(-this.maxEntries);
            } catch (error) {
                Logger.warn("Dataset: falha ao carregar historico.", error?.message || error);
            }
        },
        persist() {
            try {
                PageWindow.localStorage?.setItem(this.storageKey, JSON.stringify(this.entries.slice(-this.maxEntries)));
            } catch (error) {
                Logger.warn("Dataset: falha ao salvar historico.", error?.message || error);
            }
        },
        record(state, decision, signature) {
            if (!state || !decision || signature === this.lastSignature) return;
            this.lastSignature = signature;
            this.entries.push({
                time: Date.now(),
                hand: state.cards.map(card => GameRules.cardId(card)),
                table: state.tableCards.map(card => `${GameRules.cardId(card)}@${card.playerPosition ?? "?"}`),
                turned: state.turnedCard ? GameRules.cardId(state.turnedCard) : null,
                score: { nos: state.placar.nos, eles: state.placar.eles },
                tento: TrucoState.getValorPontos(),
                round: state.rodadaAtual,
                tricks: [state.rodadasNossa, state.rodadasEles],
                isMao10: Boolean(state.isMao10),
                handScore: state.handScore,
                contextualScore: state.contextualScore,
                winChance: state.winChance,
                position: state.minhaPosicaoNaRodada,
                transport: "NATIVE_API",
                decision: decision.suggestion,
                featureTag: decision.featureTag || null,
                confidence: decision.confidence,
                reason: decision.reason,
                outcome: null,
            });
            this.entries = this.entries.slice(-this.maxEntries);
            this.persist();
        },
        resolve(previousScore, currentScore) {
            if (!previousScore || !currentScore || !this.entries.length) return;
            const deltaNos = currentScore.nos - previousScore.nos;
            const deltaEles = currentScore.eles - previousScore.eles;
            const outcome = deltaNos === deltaEles ? "EMPATE_PLACAR"
                : deltaNos > deltaEles ? "NOSSA_DUPLA" : "ADVERSARIOS";
            const pending = this.entries.slice().reverse().find(entry => entry.outcome === null);
            if (pending) {
                pending.outcome = outcome;
                pending.scoreDelta = { nos: deltaNos, eles: deltaEles };
                this.persist();
            }
        },
        tagLastFeature(featureTag) {
            const pending = this.entries.slice().reverse().find(entry => entry.outcome === null);
            if (!pending) return false;
            pending.featureTag = featureTag;
            this.persist();
            return true;
        },
        exportJSON() {
            const blob = new Blob([JSON.stringify(this.entries, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `truco_dataset_${Date.now()}.json`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            Logger.info(`Dataset exportado: ${this.entries.length} registros.`);
            return this.entries.length;
        },
        analyze() {
            const resolved = this.entries.filter(entry => entry.outcome);
            const groups = {};
            const scoreBuckets = {};
            const featureGroups = {};
            const highConfidenceLosses = [];
            const mao10 = { total: 0, played: 0, wins: 0, losses: 0 };
            resolved.forEach(entry => {
                const key = entry.decision || "DESCONHECIDA";
                if (!groups[key]) groups[key] = { total: 0, wins: 0, losses: 0, unresolved: 0, confidence: 0 };
                const group = groups[key];
                group.total += 1;
                group.confidence += Number(entry.confidence) || 0;
                if (entry.outcome === "NOSSA_DUPLA") group.wins += 1;
                else if (entry.outcome === "ADVERSARIOS") group.losses += 1;
                else group.unresolved += 1;
                const score = Number(entry.contextualScore);
                if (Number.isFinite(score)) {
                    const bucket = `${Math.floor(score / 10) * 10}-${Math.floor(score / 10) * 10 + 9}`;
                    if (!scoreBuckets[bucket]) scoreBuckets[bucket] = { total: 0, wins: 0, losses: 0 };
                    scoreBuckets[bucket].total += 1;
                    if (entry.outcome === "NOSSA_DUPLA") scoreBuckets[bucket].wins += 1;
                    if (entry.outcome === "ADVERSARIOS") scoreBuckets[bucket].losses += 1;
                }
                if (entry.confidence >= 75 && entry.outcome === "ADVERSARIOS") highConfidenceLosses.push(entry);
                if (entry.isMao10) {
                    mao10.total += 1;
                    if (["JOGAR_MAO10", "CORRER_MAO10"].includes(entry.decision)) mao10.played += 1;
                    if (entry.outcome === "NOSSA_DUPLA") mao10.wins += 1;
                    if (entry.outcome === "ADVERSARIOS") mao10.losses += 1;
                }
                if (entry.featureTag) {
                    if (!featureGroups[entry.featureTag]) {
                        featureGroups[entry.featureTag] = { total: 0, wins: 0, losses: 0 };
                    }
                    const feature = featureGroups[entry.featureTag];
                    feature.total += 1;
                    if (entry.outcome === "NOSSA_DUPLA") feature.wins += 1;
                    if (entry.outcome === "ADVERSARIOS") feature.losses += 1;
                }
            });
            Object.values(groups).forEach(group => {
                group.winRate = group.total ? +(group.wins / group.total * 100).toFixed(1) : 0;
                group.averageConfidence = group.total ? +(group.confidence / group.total).toFixed(1) : 0;
                delete group.confidence;
            });
            Object.values(scoreBuckets).forEach(bucket => {
                bucket.winRate = bucket.total ? +(bucket.wins / bucket.total * 100).toFixed(1) : 0;
            });
            Object.values(featureGroups).forEach(feature => {
                feature.winRate = feature.total ? +(feature.wins / feature.total * 100).toFixed(1) : 0;
            });
            const result = {
                registros: this.entries.length,
                resolvidos: resolved.length,
                porDecisao: groups,
                porFaixaScore: scoreBuckets,
                porFeature: featureGroups,
                errosAltaConfianca: highConfidenceLosses.length,
                amostrasAltaConfiancaPerdidas: highConfidenceLosses.slice(-10),
                mao10,
                ultimaAtualizacao: new Date().toISOString(),
            };
            console.table(Object.entries(groups).map(([decision, data]) => ({ decision, ...data })));
            console.table(Object.entries(scoreBuckets).map(([faixa, data]) => ({ faixa, ...data })));
            console.table(Object.entries(featureGroups).map(([feature, data]) => ({ feature, ...data })));
            Logger.info("Mao de 10 no dataset:", mao10);
            if (highConfidenceLosses.length) Logger.warn("Erros com confianca >=75:", highConfidenceLosses.slice(-3));
            Logger.info("Resumo do dataset:", result);
            return result;
        },
        clear() {
            this.entries = [];
            this.lastSignature = null;
            try { PageWindow.localStorage?.removeItem(this.storageKey); } catch (_) {}
        },
    };

    // =====================
    // OPPONENT MODEL (memoria temporal de blefe)
    // =====================
    const OpponentModel = {
        storageKey: "__TRUCO_QA_OPPONENTS_V1__",
        maxEvents: 120,
        profiles: new Map(),
        events: [],
        lastRequester: null,
        lastRequestSignature: null,
        pendingRequest: null,
        init() {
            try {
                const raw = PageWindow.localStorage?.getItem(this.storageKey);
                const saved = raw ? JSON.parse(raw) : null;
                if (saved?.profiles && typeof saved.profiles === "object") {
                    Object.entries(saved.profiles).forEach(([name, profile]) => {
                        this.profiles.set(name, this.normalizeProfile(profile));
                    });
                }
                if (Array.isArray(saved?.events)) this.events = saved.events.slice(-this.maxEvents);
            } catch (error) {
                Logger.warn("Nao foi possivel carregar perfis dos adversarios.", error?.message || error);
            }
        },
        normalizeProfile(profile = {}) {
            return {
                requests: Number(profile.requests) || 0,
                aggressive: Number(profile.aggressive) || 0,
                resolved: Number(profile.resolved) || 0,
                winsAfterRequest: Number(profile.winsAfterRequest) || 0,
                lossesAfterRequest: Number(profile.lossesAfterRequest) || 0,
                foldsAfterRequest: Number(profile.foldsAfterRequest) || 0,
                raises: Number(profile.raises) || 0,
                totalValue: Number(profile.totalValue) || 0,
                bluffScore: Utils.clamp(Number(profile.bluffScore) || 0.5, 0.05, 0.95),
                recent: Array.isArray(profile.recent) ? profile.recent.slice(-12) : [],
                lastSeen: Number(profile.lastSeen) || 0,
            };
        },
        persist() {
            try {
                PageWindow.localStorage?.setItem(this.storageKey, JSON.stringify({
                    version: 1,
                    profiles: Object.fromEntries(this.profiles.entries()),
                    events: this.events.slice(-this.maxEvents),
                }));
            } catch (error) {
                Logger.warn("Nao foi possivel salvar perfis dos adversarios.", error?.message || error);
            }
        },
        getName() {
            return Utils.$("#popupTrucar #jogadorEsq .nome")?.textContent?.trim() || "desconhecido";
        },
        profile(name = this.getName()) {
            if (!this.profiles.has(name)) this.profiles.set(name, {
                requests: 0,
                aggressive: 0,
                resolved: 0,
                winsAfterRequest: 0,
                lossesAfterRequest: 0,
                foldsAfterRequest: 0,
                raises: 0,
                totalValue: 0,
                recent: [],
                bluffScore: 0.5,
                lastSeen: 0,
            });
            return this.profiles.get(name);
        },
        observeRequest(value, context = {}) {
            const name = this.getName();
            const signature = `${name}|${value}|${Utils.$(Config.selectors.popupTruco)?.textContent?.trim() || ""}`;
            if (signature === this.lastRequestSignature) return;
            this.lastRequestSignature = signature;
            const p = this.profile(name);
            const now = Date.now();
            p.requests += 1;
            p.aggressive += value >= 6 ? 2 : 1;
            p.totalValue += value;
            p.raises += value > 4 ? 1 : 0;
            p.lastSeen = now;
            p.recent.push({ time: now, value, round: context.round || 0 });
            p.recent = p.recent.filter(item => now - item.time < 20 * 60 * 1000).slice(-12);
            this.events.push({ type: "request", name, value, time: now,
                round: context.round || 0, score: context.score || null, resolved: false });
            this.events = this.events.slice(-this.maxEvents);
            this.lastRequester = name;
            this.pendingRequest = { name, value, time: now, eventIndex: this.events.length - 1 };
            Logger.info(`Perfil ${name}: pedido ${value}, ${p.requests} observados; estilo ${this.insight(name).style}.`);
            this.persist();
        },
        markOutcome(won, result = "won") {
            const pending = this.pendingRequest;
            if (!pending) return;
            const p = this.profile(pending.name);
            p.resolved += 1;
            if (won) p.winsAfterRequest += 1;
            else p.lossesAfterRequest += 1;
            if (result === "fold") p.foldsAfterRequest += 1;
            // Evidencia recente pesa mais que o histórico: perder após pedir
            // reduz a força estimada e ganhar aumenta a confiança no pedido.
            const evidence = won ? 0.2 : 0.8;
            const weight = p.resolved < 4 ? 0.12 : 0.2;
            p.bluffScore = Utils.clamp(p.bluffScore * (1 - weight) + evidence * weight, 0.05, 0.95);
            const event = this.events[pending.eventIndex];
            if (event) { event.resolved = true; event.won = Boolean(won); event.result = result; }
            Logger.info(`Perfil ${pending.name}: ${this.insight(pending.name).style}, ${p.resolved} resultados, blefe estimado ${Math.round(p.bluffScore * 100)}%.`);
            this.pendingRequest = null;
            this.persist();
        },
        insight(name = this.lastRequester) {
            const p = this.profile(name || "desconhecido");
            const sample = p.resolved;
            const bluffRate = sample ? p.lossesAfterRequest / sample : 0.5;
            const highRequestRate = p.requests ? p.raises / p.requests : 0;
            let style = "sem amostra";
            if (sample >= 3) {
                if (bluffRate >= 0.62) style = "blefador";
                else if (highRequestRate >= 0.55 && bluffRate >= 0.45) style = "agressivo";
                else if (bluffRate <= 0.28 && highRequestRate <= 0.5) style = "conservador";
                else style = "equilibrado";
            }
            return { name, sample, requests: p.requests, bluffRate, highRequestRate, style };
        },
        bluffAdjustment() {
            if (!this.lastRequester) return 0;
            const p = this.profile(this.lastRequester);
            // Sem amostra minima, o perfil nao altera a decisao.
            if (p.resolved < 3) return 0;
            // O limite evita aceitar qualquer pedido de um blefador.
            return Utils.clamp(Math.round((p.bluffScore - 0.5) * 14), -7, 7);
        },
        summary() {
            return this.lastRequester ? this.insight(this.lastRequester) : null;
        },
        cardWeight(card) {
            if (TrucoState.quemPediu !== "eles" || !TrucoState.aguardandoResposta) return 1;
            const strength = GameRules.strength(card);
            let weight = strength >= 9 ? 1.35 : strength <= 4 ? 0.78 : 1;
            const p = this.lastRequester ? this.profile(this.lastRequester) : null;
            if (p?.resolved >= 3 && p.bluffScore > 0.62) weight *= 0.9;
            return weight;
        },
        reset() {
            this.profiles.clear();
            this.events = [];
            this.lastRequester = null;
            this.lastRequestSignature = null;
            this.pendingRequest = null;
            try { PageWindow.localStorage?.removeItem(this.storageKey); } catch (_) {}
        },
    };

    // =====================
    // ROUND STATE (sincroniza rodada, placar e tentos)
    // =====================
    const RoundState = {
        signature: null,
        scoreSignature: null,
        lastCardsAt: 0,
        lastHandCount: 0,
        lastHandIds: [],
        previousTableCards: [],
        previousTableElementCount: 0,
        currentRoundCards: [],
        tricksWon: [0, 0],
        roundsCompleted: 0,
        roundsTied: 0,
        awaitingDeal: false,

        cardSignature(snapshot) {
            const cards = [...(snapshot.handCards || []), ...(snapshot.tableCards || [])]
                .map(c => GameRules.cardId(c))
                .sort()
                .join(",");
            const virada = snapshot.turnedCard ? GameRules.cardId(snapshot.turnedCard) : "sem-virada";
            return `${virada}|${cards}`;
        },

        scoreKey(score) {
            if (!score) return "0:0";
            return `${score.nos}:${score.eles}`;
        },

        reset() {
            this.signature = null;
            this.scoreSignature = null;
            this.lastCardsAt = 0;
            this.lastHandCount = 0;
            this.lastHandIds = [];
            this.previousTableCards = [];
            this.previousTableElementCount = 0;
            this.currentRoundCards = [];
            this.tricksWon = [0, 0];
            this.roundsCompleted = 0;
            this.roundsTied = 0;
            this.awaitingDeal = false;
        },

        registerClosedRound(currentTable, currentElementCount) {
            const currentKeys = new Set((currentTable || [])
                .map(card => `${GameRules.cardId(card)}@${card.playerPosition ?? "?"}`));
            const newRoundStarted = this.previousTableElementCount >= 3
                && currentElementCount === 1
                && currentKeys.size > 0
                && !this.currentRoundCards.some(card =>
                    currentKeys.has(`${GameRules.cardId(card)}@${card.playerPosition ?? "?"}`));
            if (this.previousTableElementCount < 2
                || (currentElementCount > 0 && !newRoundStarted)) return;
            this.roundsCompleted = Math.min(3, this.roundsCompleted + 1);
            const completedCards = this.currentRoundCards.length
                ? this.currentRoundCards : this.previousTableCards;
            this.currentRoundCards = [];
            if (!completedCards.length) {
                Logger.info("Rodada encerrada sem cartas suficientes para identificar o vencedor.");
                return;
            }
            const maxStrength = Math.max(...completedCards.map(card => GameRules.strength(card)));
            const leaders = completedCards.filter(card => GameRules.strength(card) === maxStrength);
            if (leaders.some(card => card.playerPosition == null)) {
                Logger.info("Rodada encerrada sem posicao confiavel para o vencedor.");
                return;
            }
            const teams = new Set(leaders
                .filter(card => card.playerPosition != null)
                .map(card => [0, 2].includes(card.playerPosition) ? 0 : 1));
            if (teams.size !== 1) {
                this.roundsTied = Math.min(3, this.roundsTied + 1);
                Logger.info("Rodada encerrada: empate.");
                return;
            }
            const team = [...teams][0];
            this.tricksWon[team] = Math.min(2, this.tricksWon[team] + 1);
            Logger.info("Rodada encerrada:", team === 0 ? "nossa dupla" : "adversarios",
                `${this.tricksWon[0]}x${this.tricksWon[1]}`);
        },

        sync(snapshot, score) {
            const handCount = snapshot.handCards?.length || 0;
            const tableElementCount = snapshot.tableElementCount || 0;
            const visibleCards = handCount + tableElementCount;
            const newScoreSignature = this.scoreKey(score);
            const newSignature = this.cardSignature(snapshot);
            const currentHandIds = (snapshot.handCards || []).map(card => GameRules.cardId(card)).sort();
            const commonHandCards = currentHandIds.filter(id => this.lastHandIds.includes(id)).length;
            const handChangedWithoutScore = this.lastHandIds.length >= 3
                && currentHandIds.length >= 3
                && commonHandCards === 0
                && (snapshot.tableElementCount || 0) <= 1;
            const scoreChanged = this.scoreSignature && this.scoreSignature !== newScoreSignature;
            const newHandDealt = this.signature !== null && handCount >= 3 && this.lastHandCount < 3;
            const cardsCleared = this.lastHandCount > 0
                && visibleCards === 0
                && Date.now() - this.lastCardsAt > 800;
            const resetAtHandEnd = Boolean(scoreChanged || cardsCleared || handChangedWithoutScore);
            const resetAtDeal = Boolean(newHandDealt && !this.awaitingDeal);

            this.registerClosedRound(snapshot.tableCards || [], tableElementCount);
            (snapshot.tableCards || []).forEach(card => {
                const key = `${GameRules.cardId(card)}@${card.playerPosition ?? "?"}`;
                if (!this.currentRoundCards.some(saved =>
                    `${GameRules.cardId(saved)}@${saved.playerPosition ?? "?"}` === key)) {
                    this.currentRoundCards.push(card);
                }
            });

            if (visibleCards > 0) this.lastCardsAt = Date.now();
            if (resetAtHandEnd || resetAtDeal) {
                if (scoreChanged && this.scoreSignature) {
                    const previous = this.scoreSignature.split(":").map(Number);
                    const current = newScoreSignature.split(":").map(Number);
                    const previousScore = { nos: previous[0] || 0, eles: previous[1] || 0 };
                    const currentScore = { nos: current[0] || 0, eles: current[1] || 0 };
                    DatasetCollector.resolve(previousScore, currentScore);
                    OpponentModel.markOutcome((current[1] || 0) > (previous[1] || 0));
                }
                TrucoState.reset();
                Mao10State.reset();
                MemoryTracker.reset();
                this.previousTableCards = [];
                this.previousTableElementCount = 0;
                this.currentRoundCards = [];
                this.tricksWon = [0, 0];
                this.roundsCompleted = 0;
                this.roundsTied = 0;
                Logger.info("Nova mao detectada - estado de truco, rodadas e memoria reiniciado.", {
                    scoreChanged, newHandDealt, cardsCleared, handChangedWithoutScore,
                });
            }
            if (resetAtHandEnd) this.awaitingDeal = true;
            if (handCount >= 3) this.awaitingDeal = false;

            this.signature = newSignature;
            this.scoreSignature = newScoreSignature;
            this.lastHandCount = handCount;
            this.lastHandIds = currentHandIds;
            this.previousTableCards = (snapshot.tableCards || []).slice();
            this.previousTableElementCount = tableElementCount;
        },
    };

    // =====================
    // LOGGER
    // =====================
    const Logger = {
        info(...args) { console.log("[QA Truco]", ...args); },
        warn(...args) { console.warn("[QA Truco]", ...args); },
        error(...args) { console.error("[QA Truco]", ...args); },
    };

    const ErrorSnapshot = {
        capture(reason, error, extra = {}) {
            const snapshot = {
                timestamp: new Date().toISOString(),
                reason,
                errorMessage: error?.message || String(error || "Erro desconhecido"),
                errorStack: error?.stack || null,
                url: PageWindow.location?.href || "",
                mesaHTML: Utils.$(Config.selectors.mesa)?.outerHTML?.slice(0, 12000) || null,
                popupHTML: Utils.$(Config.selectors.popupJogo)?.outerHTML?.slice(0, 8000) || null,
                placar: (() => {
                    try { return ScoreReader.read(); } catch (_) { return null; }
                })(),
                truco: {
                    valor: TrucoState.getValorPontos(),
                    quemPediu: TrucoState.quemPediu,
                    paraParceiro: TrucoState.paraParceiro,
                },
                socketRecebido: SocketAdapter.data.received.slice(-10),
                socketEnviado: SocketAdapter.data.sent.slice(-10),
                ...extra,
            };
            PageWindow.__LAST_TRUCO_CRASH__ = snapshot;
            Logger.error("Snapshot de erro capturado:", snapshot);
            return snapshot;
        },
    };

    // =====================
    // UTILS
    // =====================
    const Utils = {
        $(selector, root = document) { return root.querySelector(selector); },
        $all(selector, root = document) { return Array.from(root.querySelectorAll(selector)); },
        getText(selector, fallback = "0") {
            try { return Utils.$(selector)?.textContent?.trim() || fallback; } catch(e) { return fallback; }
        },
        parseNumber(text, fallback = 0) {
            const match = String(text || "").match(/-?\d+/);
            return match ? parseInt(match[0], 10) : fallback;
        },
        clamp(value, min, max) { return Math.max(min, Math.min(max, value)); },
        isVisible(element) {
            if (!element) return false;
            const style = getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
            const rect = element.getBoundingClientRect();
            return Boolean(element.getClientRects().length && rect.width > 0 && rect.height > 0);
        },
        isMyTurn() {
            const mensagem = Utils.$("#mensagem");
            if (mensagem && Utils.isVisible(mensagem) && /sua\s+vez/i.test(mensagem.textContent || "")) return true;
            // O Trucoon so libera estes controles para quem esta na vez. Na
            // abertura da mao apenas #mensagem aparece, por isso ele e o teste principal.
            return ["#acoesCartaVirada", "#trucoAumentar"].some(selector => {
                const controle = Utils.$(selector);
                return Boolean(controle && Utils.isVisible(controle)
                    && getComputedStyle(controle).visibility === "visible");
            });
        },
        turnDebug() {
            const mensagem = Utils.$("#mensagem");
            const controles = ["#acoesCartaVirada", "#trucoAumentar"].map(selector => {
                const el = Utils.$(selector);
                return {
                    selector,
                    existe: Boolean(el),
                    visivel: Utils.isVisible(el),
                    visibility: el ? getComputedStyle(el).visibility : "-",
                    display: el ? getComputedStyle(el).display : "-",
                };
            });
            return {
                mensagem: mensagem?.textContent?.trim() || "",
                mensagemVisivel: Utils.isVisible(mensagem),
                controles,
                minhaVez: this.isMyTurn(),
            };
        },
        isMao10Open() {
            const popup = Utils.$(Config.selectors.popupMao10);
            return Boolean(popup && Utils.isVisible(popup));
        },
        isInsideTrucoPopup(element) {
            return Boolean(element?.closest?.(Config.selectors.popupTruco));
        },
        isTrucoPopupVisible() {
            const popup = Utils.$(Config.selectors.popupTruco);
            const aceitar = Utils.$(Config.selectors.popupTrucoAceitar);
            const correr = Utils.$(Config.selectors.popupTrucoCorrer);
            if ((aceitar && Utils.isVisible(aceitar)) || (correr && Utils.isVisible(correr))) return true;

            const jogo = Utils.$(Config.selectors.popupJogo);
            if (!jogo || (!Utils.isVisible(jogo) && jogo.style.display !== "block")
                || !popup || popup.style.display === "none") return false;
            if (Utils.isVisible(popup) || popup.style.display === "block") return true;

            // No pedido ao parceiro, o site pode manter #popupJogo como
            // display:none enquanto #popupTrucar e os botoes de opiniao ja
            // estao preparados. Nao dependa do retangulo nesse caso.
            const opiniao = Utils.$(Config.selectors.popupTrucoAjude);
            return Boolean(opiniao && popup && popup.style.display !== "none");
        },
        readPartnerOpinion() {
            const element = Utils.$(Config.selectors.parceiroOpiniao);
            if (!element || !Utils.isVisible(element)) return null;
            const className = String(element.className || "").toLowerCase();
            const text = String(element.textContent || "").trim();
            if (className.includes("corre") || /corre/i.test(text)) {
                return { action: "CORRER", value: 0, text };
            }
            if (className.includes("aceita") || /aceita/i.test(text)) {
                return { action: "ACEITAR", value: TrucoState.getValorPontos(), text };
            }
            const raises = [
                { className: "doze", pattern: /doze/i, value: 12 },
                { className: "nove", pattern: /nove/i, value: 10 },
                { className: "seis", pattern: /seis/i, value: 8 },
            ];
            const raise = raises.find(item => className.includes(item.className) || item.pattern.test(text));
            return raise ? { action: "AUMENTAR", value: raise.value, text } : null;
        },
        parseTrucoValue(texto, fallback = 2) {
            const normalized = String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
            const numeric = normalized.match(/\b(12|10|9|8|6|4|2)\b/);
            if (numeric) {
                const value = parseInt(numeric[1], 10);
                return value === 6 ? 8 : value === 9 ? 10 : value;
            }
            if (normalized.includes("doze")) return 12;
            if (normalized.includes("nove") || normalized.includes("noove")) return 10;
            if (normalized.includes("seis") || normalized.includes("seeis")) return 8;
            if (normalized.includes("quatro") || normalized.includes("truco")) return 4;
            if (normalized.includes("dois")) return 2;
            return fallback;
        },
        previousTrucoValue(raiseValue) {
            const index = Config.trucoSequence.findIndex(value => value >= raiseValue);
            if (index <= 0) return Config.trucoSequence[0];
            return Config.trucoSequence[index - 1];
        },
        detectarValorTruco(fallback = 4) {
            const aumentar = Utils.$(Config.selectors.popupTrucoAumentar);
            if (aumentar && Utils.isVisible(aumentar)) {
                const valorAumento = Utils.parseTrucoValue(aumentar.textContent, 0);
                if (valorAumento) return Utils.previousTrucoValue(valorAumento);
            }

            const candidatos = [
                Config.selectors.popupTrucoAceitar,
                Config.selectors.popupTrucoCorrer,
            ];
            for (const selector of candidatos) {
                const el = Utils.$(selector);
                if (el && Utils.isVisible(el)) return Utils.parseTrucoValue(el.textContent, fallback);
            }
            return fallback;
        },
        dispatchHumanClick(element) {
            if (!element) {
                Logger.warn("Clique nativo ignorado: elemento ausente.");
                return false;
            }
            try {
                const rect = element.getBoundingClientRect();
                if (!rect.width || !rect.height) {
                    Logger.warn("Clique nativo ignorado: elemento sem area visivel.", {
                        id: element.id, className: element.className,
                        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    });
                    return false;
                }
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                const alvo = document.elementFromPoint(x, y) || element;
                const eventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
                Logger.info("Clique nativo iniciado:", {
                    id: element.id, className: element.className,
                    alvo: alvo.id || alvo.className || alvo.tagName,
                    x: Math.round(x), y: Math.round(y),
                });
                if (typeof PointerEvent === "function") alvo.dispatchEvent(new PointerEvent("pointerdown", eventInit));
                alvo.dispatchEvent(new MouseEvent("mousedown", eventInit));
                if (typeof PointerEvent === "function") alvo.dispatchEvent(new PointerEvent("pointerup", eventInit));
                alvo.dispatchEvent(new MouseEvent("mouseup", eventInit));
                alvo.click();
                Logger.info("Clique nativo concluido:", element.id || element.className);
                return true;
            } catch (error) {
                Logger.error("Falha no clique nativo:", {
                    id: element.id, className: element.className,
                    message: error?.message || error, stack: error?.stack,
                });
                return false;
            }
        },
    };

    const TimeBarReader = {
        remainingPercent() {
            const bar = Utils.$(Config.selectors.barraTempo);
            if (!bar) return 100;
            const width = parseFloat(String(bar.style.width || "100%").replace("%", ""));
            return Number.isFinite(width) ? Utils.clamp(width, 0, 100) : 100;
        },
        isCritical() { return this.remainingPercent() <= RuntimeConfig.criticalTimePercent; },
    };

    // =====================
    // QUERY CACHE
    // =====================
    class QueryCache {
        constructor(root = document) {
            this.root = root;
            this.version = 0;
            this.store = new Map();
        }
        invalidate() {
            this.version += 1;
            this.store.clear();
        }
        all(selector) {
            const cached = this.store.get(selector);
            if (cached && cached.version === this.version) return cached.value;
            const value = Utils.$all(selector, this.root);
            this.store.set(selector, { version: this.version, value });
            return value;
        }
        one(selector) {
            return this.all(selector)[0] || null;
        }
    }

    // =====================
    // SOCKET ADAPTER
    // =====================
    const SocketAdapter = {
        data: { sent: [], received: [], lastGameData: null },
        installed: false,
        install() {
            const WebSocketCtor = PageWindow.WebSocket;
            if (this.installed || !WebSocketCtor?.prototype) return;
            this.installed = true;
            const origSend = WebSocketCtor.prototype.send;
            WebSocketCtor.prototype.send = function(p) { SocketAdapter.recordSent(p); return origSend.call(this, p); };
            const origAdd = WebSocketCtor.prototype.addEventListener;
            WebSocketCtor.prototype.addEventListener = function(t, fn, opts) {
                if (t !== "message" || typeof fn !== "function") return origAdd.call(this, t, fn, opts);
                const wfn = function(e) { SocketAdapter.recordReceived(e.data); return fn.call(this, e); };
                return origAdd.call(this, t, wfn, opts);
            };
            Logger.info("Sniffer WebSocket instalado.");
        },
        recordSent(p) {
            RingBuffer.push(this.data.sent, { time: Date.now(), data: p }, 100);
        },
        recordReceived(p) {
            RingBuffer.push(this.data.received, { time: Date.now(), data: p }, 100);
            if (typeof p === "string") { try { this.data.lastGameData = JSON.parse(p); } catch(e) {} }
        },
    };

    // O jogo aceita comandos internos por `con.envioMsgJogo`. Cartas precisam
    // do mesmo codigo/payload que a interface envia, nao de um click sintetico.
    const NativeCallTracer = {
        installed: false,
        calls: [],
        connection: null,
        wrapper: null,
        install() {
            const con = PageWindow.con;
            if (!con || typeof con.envioMsgJogo !== "function") return false;
            if (this.connection === con && con.envioMsgJogo === this.wrapper) return true;
            const original = con.envioMsgJogo;
            const tracer = this;
            const wrapper = function(...args) {
                RingBuffer.push(tracer.calls, { time: Date.now(), args }, 50);
                Logger.info("Comando nativo observado:", args[0], args[1]);
                return original.apply(this, args);
            };
            con.envioMsgJogo = wrapper;
            this.connection = con;
            this.wrapper = wrapper;
            this.installed = true;
            Logger.info("Rastreador de comandos nativos instalado.");
            return true;
        },
    };

    // =====================
    // SPRITE DECODER
    // =====================
    const CardFrameStability = {
        lastPositions: new WeakMap(),
        isStable(element, position) {
            if (!element || !position || position === "0px 0px" || position === "0% 0%") return false;
            const last = this.lastPositions.get(element);
            this.lastPositions.set(element, position);
            return last === position;
        },
    };

    const SpriteDecoder = {
        decode(element) {
            if (!element) return null;
            const style = getComputedStyle(element);
            // Durante a animação da carta o Firefox pode devolver o
            // background-size como "auto" ou ainda não refletir o estilo
            // computado, embora a posição do sprite já esteja no atributo
            // inline. A posição é a informação necessária para decodificar.
            const inlinePosition = element.style.backgroundPosition || "";
            const computedPosition = style.backgroundPosition || "";
            const bgPos = inlinePosition && inlinePosition !== "0px 0px"
                ? inlinePosition : computedPosition;
            if (!bgPos || bgPos === "0% 0%" || bgPos === "0px 0px" || bgPos === "auto auto") return null;
            if (!CardFrameStability.isStable(element, bgPos)) return null;
            const parts = bgPos.replace(/,/g, " ").replace(/\s+/g, " ").trim().split(" ");
            if (parts.length !== 2) return null;
            const x = parseFloat(parts[0]), y = parseFloat(parts[1]);
            if (isNaN(x) || isNaN(y)) return null;
            const col = Math.round(Math.abs(x) / Config.cardSprite.width);
            let row = 0, minDiff = Infinity;
            Config.cardSprite.suitRows.forEach((ry, i) => { const d = Math.abs(y - ry); if (d < minDiff) { minDiff = d; row = i; } });
            if (col < 0 || col >= Config.cardSprite.names.length || row < 0 || row >= Config.cardSprite.suits.length) return null;
            const valor = Config.cardSprite.values[col];
            return {
                element,
                nome: Config.cardSprite.names[col],
                naipe: Config.cardSprite.suits[row],
                valor,
                // Formato interno do Trucoon, por exemplo: c4 = quatro de copas.
                codigo: `${Config.cardSprite.suitCodes[row]}${valor}`,
            };
        },
    };

    // =====================
    // DOM READER
    // =====================
    class DOMReader {
        constructor(cache) { this.cache = cache; }

        getState() {
            const handCards = this.getHandCards();
            const tableCards = this.getTableCards();
            const turnedCard = this.getTurnedCard();
            const handElementCount = Utils.isMao10Open()
                ? handCards.length
                : this.cache.all(Config.selectors.allCards).filter(el => this.isHandCard(el)).length;

            // 🆕 alimenta a memória de cartas vistas nesta mão (mesa + virada)
            MemoryTracker.registrar(tableCards);
            if (turnedCard) MemoryTracker.registrar([turnedCard]);

            const snapshot = {
                handCards,
                tableCards,
                tableElementCount: this.cache.all(Config.selectors.tableCards)
                    .filter(el => Utils.isVisible(el)).length,
                handElementCount,
                turnedCard,
                seenCards: new Set(MemoryTracker.seen),
                isMao10: Mao10State.isAtiva(),
                isTrucoPending: TrucoState.isEmTruco(),
                trucoValor: TrucoState.getValorPontos(),
                trucoQuemPediu: TrucoState.quemPediu,
                partnerOpinion: Utils.readPartnerOpinion(),
                mao10Parceiro: Mao10State.cartasParceiro,
                socketData: SocketAdapter.data,
            };
            snapshot.placar = ScoreReader.read();
            RoundState.sync(snapshot, snapshot.placar);
            snapshot.isMao10 = Mao10State.isAtiva();
            snapshot.isTrucoPending = TrucoState.isEmTruco();
            snapshot.trucoValor = TrucoState.getValorPontos();
            snapshot.trucoQuemPediu = TrucoState.quemPediu;
            snapshot.partnerOpinion = Utils.readPartnerOpinion();
            return snapshot;
        }

        getHandCards() {
            // Se a mão de 10 não está mais aberta, limpar estado
            if (!Utils.isMao10Open() && Mao10State.ativa) {
                Mao10State.fechar();
                Logger.info("Mão de 10 fechada - estado limpo.");
            }

            if (Utils.isMao10Open()) {
                const popup = Utils.$(Config.selectors.popupMao10);
                const jogos = popup.querySelectorAll('.jogo');

                if (jogos.length >= 2) {
                    const cartasParceiro = [];
                    const cartasMinhas = [];

                    // Cartas do parceiro (jogos[0])
                    jogos[0].querySelectorAll('.carta[style*="background-position"]').forEach(el => {
                        const info = SpriteDecoder.decode(el);
                        if (info) cartasParceiro.push({ element: el, ...info, fromMao10: true, isParceiro: true });
                    });

                    // Minhas cartas (jogos[1])
                    jogos[1].querySelectorAll('.carta[style*="background-position"]').forEach(el => {
                        const info = SpriteDecoder.decode(el);
                        if (info) cartasMinhas.push({ element: el, ...info, fromMao10: true, isParceiro: false });
                    });

                    // Atualizar estado global da mão de 10
                    Mao10State.abrir(cartasParceiro, cartasMinhas);

                    Logger.info(`Mão de 10: ${cartasMinhas.length} minhas + ${cartasParceiro.length} do parceiro`);

                    // Retornar minhas cartas para o painel
                    return cartasMinhas;
                }
            }

            // Se não está na mão de 10, garantir que estado foi limpo
            if (Mao10State.ativa && !Utils.isMao10Open()) {
                Mao10State.fechar();
            }

            // Modo normal
            return this.cache.all(Config.selectors.allCards)
                .filter(el => this.isHandCard(el))
                .map(el => SpriteDecoder.decode(el))
                .filter(Boolean)
                .map((carta, posicao) => ({ ...carta, posicao }));
        }

        getTableCards() {
            return this.cache.all(Config.selectors.tableCards)
                .filter(el => Utils.isVisible(el))
                .map(el => {
                    const info = SpriteDecoder.decode(el);
                    if (!info) return null;
                    const jogador = el.closest(".jogador");
                    const match = jogador?.id?.match(/\d+/);
                    const playerPosition = match
                        ? Number(match[0])
                        : this.getTableCardPosition(el);
                    return { ...info, playerPosition };
                })
                .filter(Boolean);
        }

        getTableCardPosition(element) {
            const surface = element?.parentElement;
            if (!surface) return null;
            const surfaceRect = surface.getBoundingClientRect();
            if (!surfaceRect.width || !surfaceRect.height) return null;
            const transform = element.style.transform || "";
            const translated = transform.match(/translate3d\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/i);
            const cardRect = element.getBoundingClientRect();
            const relativeX = translated
                ? Number(translated[1]) + element.offsetWidth / 2
                : cardRect.left - surfaceRect.left + cardRect.width / 2;
            const relativeY = translated
                ? Number(translated[2]) + element.offsetHeight / 2
                : cardRect.top - surfaceRect.top + cardRect.height / 2;
            const surfaceWidth = translated ? surface.offsetWidth : surfaceRect.width;
            const surfaceHeight = translated ? surface.offsetHeight : surfaceRect.height;
            const left = relativeX < surfaceWidth / 2;
            const top = relativeY < surfaceHeight / 2;
            // Posicoes relativas usadas pelo Trucoon: nos embaixo/esquerda,
            // adversario em cima/esquerda, parceiro em cima/direita.
            if (!top && left) return 0;
            if (top && left) return 1;
            if (top && !left) return 2;
            return 3;
        }

        getTurnedCard() {
            const tagged = this.cache.all(".carta1")
                .filter(el => Utils.isVisible(el) && !Utils.isInsideTrucoPopup(el))
                .map(el => SpriteDecoder.decode(el))
                .find(Boolean);
            if (tagged) return tagged;
            return this.cache.all(Config.selectors.turnedCard)
                .filter(el => Utils.isVisible(el) && !Utils.isInsideTrucoPopup(el))
                .map(el => SpriteDecoder.decode(el))
                .find(Boolean) || null;
        }

        isHandCard(element) {
            if (Utils.isMao10Open()) {
                const popup = Utils.$(Config.selectors.popupMao10);
                if (popup && popup.contains(element)) {
                    return element.style.backgroundPosition && element.style.backgroundPosition !== '';
                }
            }
            return Utils.isVisible(element)
                && !Utils.isInsideTrucoPopup(element)
                && element.parentElement?.classList.contains("jogo")
                && !element.classList.contains("cartaMesa")
                && !element.classList.contains("cartaVirada")
                && !element.classList.contains("carta1")
                && !element.classList.contains("carta2")
                && !element.classList.contains("carta3")
                && !element.classList.contains("monte1")
                && !element.closest(Config.selectors.ignoredHandAncestors);
        }
    }

    // =====================
    // GAME RULES (Truco Mineiro)
    // =====================
    const GameRules = {
        baseStrengthByName: Config.cardSprite.trucoMineiroRank.reduce((m, n, i) => { m[n] = i + 1; return m; }, {}),
        manilhaKey(c) { return `${c?.nome || ""}${c?.naipe || ""}`; },
        manilhaIndex(c) {
            if (!c) return -1;
            const k = this.manilhaKey(c);
            return Config.cardSprite.trucoMineiroManilhas.findIndex(m => this.manilhaKey(m) === k);
        },
        isManilha(c) { return this.manilhaIndex(c) >= 0; },
        manilhaName(c) { const i = this.manilhaIndex(c); return i >= 0 ? Config.cardSprite.trucoMineiroManilhas[i].apelido : ""; },
        strength(c) {
            if (!c) return 0;
            const mi = this.manilhaIndex(c);
            if (mi >= 0) return 11 + mi;
            return this.baseStrengthByName[c.nome] || 0;
        },
        isCartaForte(c) { return this.strength(c) >= 7; },
        effectiveStrength(card, seenCards = new Set()) {
            const base = this.strength(card);
            const higher = this.deck().filter(other => this.strength(other) > base);
            const remainingHigher = higher.filter(other => !seenCards.has(this.cardId(other))).length;
            return {
                original: base,
                higherRemaining: remainingHigher,
                absoluteTop: remainingHigher === 0,
            };
        },
        compare(a, b) { return this.strength(a) - this.strength(b); },
        canBeat(c, opp) { return this.compare(c, opp) > 0; },
        cardId(c) { return `${c.nome}${c.naipe}`; },
        deck() { return Config.cardSprite.trucoMineiroRank.flatMap(n => Config.cardSprite.suits.map(s => ({ nome: n, naipe: s }))); },
        nextTrucoValue(current = 2) {
            const index = Config.trucoSequence.findIndex(value => value >= current);
            if (index < 0 || index >= Config.trucoSequence.length - 1) return 12;
            return Config.trucoSequence[index + 1];
        },
        // 🆕 Score único (0-100) que resume a força da mão para o motor de decisão.
        // Combina: manilhas (peso maior), cartas fortes, chance Monte Carlo e
        // cobertura contra a mesa. Substitui os limiares soltos que existiam antes.
        handScore(state) {
            const manilhas = Utils.clamp(state.manilhasCombinadas ?? 0, 0, 4);
            const fortes = Utils.clamp(state.cartasFortes ?? 0, 0, 6);
            const cobertura = state.totalCards ? (state.safeCards || 0) / state.totalCards : 0;
            let score = 0;
            score += manilhas * 20;                    // até 80 (4 manilhas só ocorre combinando com parceiro)
            score += Math.min(fortes, 3) * 7;           // até 21
            score += (state.winChance || 0) * 0.3;      // até 30
            score += cobertura * 12;                    // até 12
            return Utils.clamp(Math.round(score), 0, 100);
        },
        contextualScore(state) {
            let score = state.handScore || 0;
            if (state.tableStrongestCard) {
                if (state.tableWinnerIsOurTeam === true) score += 10;
                else if (state.cardsThatBeatTable === 0 && state.cardsThatTieTable > 0
                    && state.rodadasNossa > state.rodadasEles) score += 4;
                else if (state.cardsThatBeatTable === 0) score -= 18;
                else score += Math.min(10, state.cardsThatBeatTable * 4);
            }
            if (state.rodadasNossa > state.rodadasEles) score += 8;
            if (state.rodadasEles > state.rodadasNossa) score -= 10;
            if (state.rodadaAtual === 3) score += 5;
            if (state.placar?.pertoDePerder) score += 4;
            if (state.placar?.pertoDeGanhar
                && state.placar.diferenca >= Config.placarLimits.vantagemParaNaoArriscar) score -= 6;
            return Utils.clamp(Math.round(score), 0, 100);
        },
        scoreAggressionModifier(placar) {
            if (!placar) return 0;
            if (placar.nos >= 10 && placar.eles <= 6) return -20;
            if (placar.nos <= 4 && placar.eles >= 9) return 22;
            if (placar.nos >= 8 && placar.diferenca >= 6) return -10;
            if (placar.eles >= 8 && placar.nos <= 5) return 12;
            return 0;
        },
    };

    // =====================
    // PROBABILITY ANALYZER
    // =====================
    const ProbabilityAnalyzer = {
        estimate(state) {
            if (!state.totalCards) return { winChance: 0, samples: 0, safeCards: 0 };
            const knownIds = new Set([...state.cards, ...state.tableCards, state.turnedCard].filter(Boolean).map(c => GameRules.cardId(c)));
            // 🆕 soma as cartas já vistas em rodadas anteriores desta mão (memória),
            // encolhendo o baralho "desconhecido" e deixando a simulação mais realista.
            if (state.seenCards) state.seenCards.forEach(id => knownIds.add(id));
            const unknown = GameRules.deck().filter(c => !knownIds.has(GameRules.cardId(c)));
            const probabilities = state.cards
                .map(card => this.cardDominance(card, unknown))
                .sort((a, b) => b - a);
            let needed = Math.max(1, 2 - (state.rodadasNossa || 0));
            if (state.rodadasEmpatadas > 0
                && state.rodadasNossa === state.rodadasEles
                && state.rodadasCompletas >= 1) needed = 1;
            if (state.tableWinnerIsOurTeam === true) needed = Math.max(1, needed - 1);
            const matchChance = this.probabilityAtLeast(probabilities, needed);
            const ts = state.tableStrongestCard;
            const safe = ts ? state.cards.filter(c => GameRules.canBeat(c, ts)).length : state.cards.filter(c => this.cardDominance(c, unknown) >= 0.5).length;
            let adjustedChance = matchChance;
            if (ts) {
                const currentRoundChance = state.tableWinnerIsOurTeam === true
                    ? 0.92
                    : safe / Math.max(1, state.totalCards);
                adjustedChance = matchChance * 0.65 + currentRoundChance * 0.35;
            }
            return {
                winChance: Math.round(Utils.clamp(adjustedChance, 0, 1) * 100),
                samples: unknown.length,
                safeCards: safe,
            };
        },
        probabilityAtLeast(probabilities, needed) {
            if (needed <= 0) return 1;
            if (needed > probabilities.length) return 0;
            const distribution = new Array(probabilities.length + 1).fill(0);
            distribution[0] = 1;
            probabilities.forEach((probability, index) => {
                for (let wins = index + 1; wins >= 0; wins--) {
                    const without = (distribution[wins] || 0) * (1 - probability);
                    const withCard = wins > 0 ? (distribution[wins - 1] || 0) * probability : 0;
                    distribution[wins] = without + withCard;
                }
            });
            return distribution.slice(needed).reduce((sum, value) => sum + value, 0);
        },
        estimateDuoHand(ourCards, partnerCards) {
            if (ourCards.length !== 3 || partnerCards.length !== 3) {
                return { complete: false, winChance: 0, safeTricks: 0, profile: [] };
            }
            const knownIds = new Set([...ourCards, ...partnerCards].map(GameRules.cardId));
            const unknown = GameRules.deck().filter(card => !knownIds.has(GameRules.cardId(card)));
            const pairings = [
                [0, 1, 2], [0, 2, 1], [1, 0, 2],
                [1, 2, 0], [2, 0, 1], [2, 1, 0],
            ];
            const totalPairs = unknown.length * (unknown.length - 1) / 2;
            let best = { winChance: 0, safeTricks: 0, profile: [] };

            pairings.forEach(pairing => {
                const profile = ourCards.map((card, index) => {
                    const partnerCard = partnerCards[pairing[index]];
                    return GameRules.strength(card) >= GameRules.strength(partnerCard)
                        ? card : partnerCard;
                });
                const probabilities = profile.map(card => {
                    const strength = GameRules.strength(card);
                    const lower = unknown.filter(other => GameRules.strength(other) < strength).length;
                    const equal = unknown.filter(other => GameRules.strength(other) === strength).length;
                    const lowerPairs = lower * (lower - 1) / 2;
                    const tiedPairs = ((lower + equal) * (lower + equal - 1) / 2) - lowerPairs;
                    return Utils.clamp((lowerPairs + tiedPairs * 0.35) / Math.max(1, totalPairs), 0, 1);
                });
                const winChance = this.probabilityAtLeast(probabilities, 2);
                const safeTricks = probabilities.filter(probability => probability >= 0.55).length;
                if (winChance > best.winChance) {
                    best = {
                        winChance,
                        safeTricks,
                        profile: profile.slice().sort((a, b) => GameRules.strength(b) - GameRules.strength(a)),
                    };
                }
            });

            return {
                complete: true,
                winChance: Math.round(best.winChance * 100),
                safeTricks: best.safeTricks,
                profile: best.profile,
            };
        },
        cardDominance(card, unknown) {
            if (!unknown.length) return 1;
            const strength = GameRules.strength(card);
            let totalWeight = 0;
            let winningWeight = 0;
            unknown.forEach(other => {
                const weight = OpponentModel.cardWeight(other);
                totalWeight += weight;
                if (strength > GameRules.strength(other)) winningWeight += weight;
                else if (strength === GameRules.strength(other)) winningWeight += weight * 0.5;
            });
            return winningWeight / Math.max(0.001, totalWeight);
        },
    };

    // =====================
    // SCORE READER
    // =====================
    const ScoreReader = {
        _nossaCor: null,

        detectarNossoTime() {
            const meuAvatar = Utils.$(Config.selectors.meuAvatar);
            if (this._nossaCor && meuAvatar) {
                const corAtual = this.corDoElemento(meuAvatar);
                if (corAtual === this._nossaCor) return this._nossaCor;
                if (corAtual !== "desconhecida") this._nossaCor = null;
            } else if (this._nossaCor) {
                return this._nossaCor;
            }
            if (meuAvatar) {
                if (meuAvatar.classList.contains('vermelho')) this._nossaCor = 'vermelho';
                else if (meuAvatar.classList.contains('roxo')) this._nossaCor = 'roxo';
            }
            // 🆕 Fallback via parceiro (jogador2, posição oposta na mesa): em algumas
            // partidas o próprio avatar (#jogador0) não carrega a classe de cor,
            // mas o parceiro sempre é do MESMO time que você.
            if (!this._nossaCor) {
                const parceiroFoto = Utils.$(Config.selectors.parceiroAvatar);
                if (parceiroFoto) {
                    if (parceiroFoto.classList.contains('vermelho')) this._nossaCor = 'vermelho';
                    else if (parceiroFoto.classList.contains('roxo')) this._nossaCor = 'roxo';
                }
            }
            if (!this._nossaCor) {
                const jogadorDiv = Utils.$(`${Config.selectors.meuJogador} .foto`)
                    || Utils.$all(Config.selectors.jogadorDiv).find(foto => !Utils.isInsideTrucoPopup(foto));
                const t1Span = Utils.$(Config.selectors.time1Span);
                const t2Span = Utils.$(Config.selectors.time2Span);
                if (jogadorDiv && t1Span && t2Span) {
                    const jogBg = getComputedStyle(jogadorDiv).backgroundColor;
                    const t1Bg = getComputedStyle(t1Span).backgroundColor;
                    if (jogBg === t1Bg) this._nossaCor = 'time1';
                    else this._nossaCor = 'time2';
                }
            }
            Logger.info(`Nosso time: ${this._nossaCor}`);
            return this._nossaCor;
        },

        read() {
            try {
                const nossaCor = this.detectarNossoTime();
                const t1Pontos = Utils.$(Config.selectors.placarNos);
                const t2Pontos = Utils.$(Config.selectors.placarEles);
                const placarTime1 = this.lerPontosTime('time1', t1Pontos);
                const placarTime2 = this.lerPontosTime('time2', t2Pontos);
                const tAtv = Utils.$(Config.selectors.tentosAtv);
                const tSem = Utils.$(Config.selectors.tentosSemAtv);

                // 🆕 CORREÇÃO: antes o código assumia "vermelho = time1" fixo, o que
                // inverte nós/eles sempre que o site renderiza o time1 como roxo (como
                // no seu caso). Agora comparamos a cor REAL de cada span do placar
                // (.time1 span / .time2 span) com a nossa cor detectada.
                const corTime1 = this.corDoTime('time1');
                const corTime2 = this.corDoTime('time2');
                let nosSomosTime1;
                if (nossaCor === 'time1') nosSomosTime1 = true;
                else if (nossaCor === 'time2') nosSomosTime1 = false;
                else if (corTime1 !== 'desconhecida' && nossaCor === corTime1) nosSomosTime1 = true;
                else if (corTime2 !== 'desconhecida' && nossaCor === corTime2) nosSomosTime1 = false;
                else nosSomosTime1 = (nossaCor === 'vermelho'); // último recurso, se nada bateu

                let nos = 0, eles = 0;
                if (nosSomosTime1) {
                    nos = placarTime1;
                    eles = placarTime2;
                } else {
                    nos = placarTime2;
                    eles = placarTime1;
                }
                const tentoAtual = this.lerTentoAtual(tAtv, tSem);
                const tn = nosSomosTime1 ? tentoAtual : 0;
                const te = nosSomosTime1 ? 0 : tentoAtual;
                return {
                    nos, eles, tentosNos: tn, tentosEles: te,
                    diferenca: nos - eles,
                    estamosGanhando: nos > eles,
                    estamosPerdendo: nos < eles,
                    pertoDeGanhar: nos >= Config.placarLimits.maxTentos - 2,
                    pertoDePerder: eles >= Config.placarLimits.maxTentos - 2,
                    nossaCor,
                    times: this.detectarTimes(nossaCor),
                    tentoAtual,
                };
            } catch(e) {
                Logger.error("Erro lendo placar:", e);
                return { nos: 0, eles: 0, tentosNos: 0, tentosEles: 0, diferenca: 0,
                         estamosGanhando: false, estamosPerdendo: false,
                         pertoDeGanhar: false, pertoDePerder: false, nossaCor: 'erro', times: null, tentoAtual: 2 };
            }
        },

        lerPontosTime(timeId, popupFallback = null) {
            // 🆕 CORREÇÃO: o placar tem dois spans por time (.atv = valor real
            // exibido, .sematv = valor "desativado" que o site mantém escondido).
            // O código antigo somava TODOS os spans (.pontos .time1 span), então
            // somava .atv + .sematv (ex: 8 + 6 = 14 em vez de 8). Agora lemos
            // primeiro o .atv, que é o único valor correto.
            const atvSelector = timeId === 'time1' ? Config.selectors.pontosTime1 : Config.selectors.pontosTime2;
            const atvEl = Utils.$(atvSelector);
            const atvValor = Utils.parseNumber(atvEl?.textContent, NaN);
            if (atvEl && !Utils.isInsideTrucoPopup(atvEl) && Number.isFinite(atvValor)) return atvValor;

            // Fallback 1: somar spans genéricos (só quando não há .atv identificável,
            // ex. estrutura diferente dentro do popup de truco/mão de 11)
            const spanSelector = timeId === 'time1' ? Config.selectors.pontosTime1Spans : Config.selectors.pontosTime2Spans;
            const valoresPontos = Utils.$all(spanSelector)
                .filter(el => el && !Utils.isInsideTrucoPopup(el))
                .map(el => Utils.parseNumber(el.textContent, NaN))
                .filter(Number.isFinite);
            if (valoresPontos.length === 1) return valoresPontos[0];

            // Fallback 2: elemento do popup (ex. .pontosDuplas)
            return Utils.parseNumber(popupFallback?.textContent, 0);
        },

        lerTentoAtual(tAtv = Utils.$(Config.selectors.tentosAtv), tSem = Utils.$(Config.selectors.tentosSemAtv)) {
            const valores = [tAtv, tSem]
                .filter(el => el && Utils.isVisible(el))
                .map(el => Utils.parseNumber(el.textContent, NaN))
                .filter(Number.isFinite);
            if (valores.length) return valores[0];

            const fallback = [tAtv, tSem]
                .map(el => Utils.parseNumber(el?.textContent, NaN))
                .filter(Number.isFinite);
            return fallback.length ? fallback[0] : TrucoState.getValorPontos();
        },

        corDoElemento(element) {
            if (!element) return 'desconhecida';
            if (element.classList.contains('vermelho')) return 'vermelho';
            if (element.classList.contains('roxo')) return 'roxo';
            const bg = getComputedStyle(element).backgroundColor;
            if (bg === Config.timeColors.vermelho) return 'vermelho';
            if (bg === Config.timeColors.roxo) return 'roxo';
            return 'desconhecida';
        },

        corDoTime(timeId) {
            const selector = timeId === 'time1' ? Config.selectors.time1Span : Config.selectors.time2Span;
            return this.corDoElemento(Utils.$(selector));
        },

        detectarTimes(nossaCor = this.detectarNossoTime()) {
            const jogadoresMesa = Utils.$all(Config.selectors.jogadoresMesa)
                .filter(jogador => Utils.isVisible(jogador));
            const fotos = jogadoresMesa.length
                ? jogadoresMesa.map(jogador => Utils.$('.foto', jogador)).filter(Boolean)
                : Utils.$all(Config.selectors.jogadorDiv).filter(foto => !Utils.isInsideTrucoPopup(foto));
            const jogadores = fotos.map((foto, index) => {
                const jogador = foto.closest('.jogador') || foto.parentElement;
                const jogadorId = jogador?.id || "";
                const posicao = Number((jogadorId.match(/\d+/) || [index])[0]);
                const cor = this.corDoElemento(foto);
                return {
                    index: index + 1,
                    posicao,
                    id: jogadorId,
                    cor,
                    meuJogador: jogadorId === 'jogador0',
                    parceiro: posicao === 0 || posicao === 2,
                    texto: (jogador?.textContent || '').trim().replace(/\s+/g, ' ')
                };
            });
            const corBase = nossaCor === 'time1' || nossaCor === 'time2' ? this.corDoTime(nossaCor) : nossaCor;
            const corOponente = corBase === 'vermelho' ? 'roxo' : (corBase === 'roxo' ? 'vermelho' : 'desconhecida');
            return {
                nossaCor: corBase || 'desconhecida',
                corParceiro: corBase || 'desconhecida',
                corOponente,
                jogadores,
                parceiros: jogadores.filter(j => j.parceiro || j.cor === corBase),
                oponentes: jogadores.filter(j => !j.parceiro && j.cor === corOponente),
            };
        },
    };

    // =====================
    // TRUCO DETECTOR
    // =====================
    function detectarTrucoRecebido() {
        if (Utils.isTrucoPopupVisible()) {
            if (!TrucoState.pedidoFoiParaNossaDupla()) return false;
            if (TrucoState.respondida) return false;
            // Os botoes "aceitar/correr" nao trazem o valor no texto. Se nao
            // houver aumento anterior, o pedido recebido e o Truco normal.
            const valorAtual = TrucoState.getValorPontos();
            const fallback = valorAtual >= 10
                ? 12 : valorAtual > Config.trucoSequence[0] ? valorAtual : 4;
            const valor = Utils.detectarValorTruco(fallback);
            if (!TrucoState.aguardandoResposta) {
                TrucoState.receberPedido(valor);
                TrucoState.paraParceiro = TrucoState.pedidoFoiParaParceiro();
                OpponentModel.observeRequest(valor, {
                    score: ScoreReader.read(),
                    round: RoundState.roundsCompleted + 1,
                });
                Logger.info(`🔥 Truco ${TrucoState.paraParceiro ? "para o parceiro" : "para mim"}: ${TrucoState.getValorText()} (${TrucoState.getValorPontos()} pontos)`);
                return true;
            }
            // 🆕 CORREÇÃO: cobre tanto "eles aumentaram de novo" quanto o caso que
            // antes ficava travado — "eu pedi, eles contra-aumentaram". Antes a
            // condição exigia quemPediu === 'eles', então um contra-aumento em cima
            // do MEU pedido nunca era detectado e o painel ficava mudo.
            if (valor > TrucoState.getValorPontos()) {
                TrucoState.receberPedido(valor);
                Logger.info(`🔥 Valor do truco atualizado para ${TrucoState.getValorText()} (${TrucoState.getValorPontos()} pontos)`);
                return true;
            }
        }
        if (!Utils.isTrucoPopupVisible()
            && (TrucoState.aguardandoResposta || TrucoState.respondida)
            && TrucoState.quemPediu === 'eles') {
            TrucoState.aguardandoResposta = false;
            TrucoState.respondida = false;
            TrucoState.paraParceiro = false;
            Logger.info("Truco resolvido; valor mantido ate a proxima mao.");
        }
        return false;
    }

    // =====================
    // GAME STATE
    // =====================
    class GameState {
        constructor(snapshot) {
            this.cards = snapshot.handCards;
            this.tableCards = snapshot.tableCards;
            this.tableElementCount = snapshot.tableElementCount || this.tableCards.length;
            this.handElementCount = snapshot.handElementCount || this.cards.length;
            this.turnedCard = snapshot.turnedCard;
            this.seenCards = snapshot.seenCards || new Set();
            this.isMao10 = snapshot.isMao10 || false;
            this.isTrucoPending = snapshot.isTrucoPending || false;
            this.trucoValor = snapshot.trucoValor || 2;
            this.trucoQuemPediu = snapshot.trucoQuemPediu || null;
            this.partnerOpinion = snapshot.partnerOpinion || null;
            this.mao10Parceiro = snapshot.mao10Parceiro || [];
            this.planejamentoParceiro = Mao10State.planejamentoParceiro || [];
            this.totalCards = this.cards.length;
            this.effectiveStrengths = this.cards.map(card => ({
                card,
                ...GameRules.effectiveStrength(card, this.seenCards),
            }));
            const partnerCardsSeen = this.tableCards.filter(card => card.playerPosition === 2);
            this.partnerStrengthEstimate = partnerCardsSeen.length
                ? Math.max(...partnerCardsSeen.map(card => GameRules.strength(card)))
                : 0;
            this.partnerHasStrongEvidence = this.partnerStrengthEstimate >= 9;
            this.inputIncomplete = this.tableElementCount > this.tableCards.length
                || this.handElementCount > this.cards.length;
            this.manilhas = this.cards.filter(c => GameRules.isManilha(c)).length;
            this.totalStrength = this.cards.reduce((s, c) => s + GameRules.strength(c), 0);
            this.averageStrength = this.totalCards ? +(this.totalStrength / this.totalCards).toFixed(1) : 0;
            this.handPower = this.totalCards ? +((this.totalStrength / (this.totalCards * 14)) * 100).toFixed(0) : 0;
            this.tableStrongestCard = this.tableCards.reduce((b, c) => !b ? c : (GameRules.compare(c, b) > 0 ? c : b), null);
            const tableLeaders = this.tableStrongestCard
                ? this.tableCards.filter(card => GameRules.compare(card, this.tableStrongestCard) === 0)
                : [];
            const tableLeaderTeams = new Set(tableLeaders
                .filter(card => card.playerPosition != null)
                .map(card => [0, 2].includes(card.playerPosition) ? 0 : 1));
            this.tableWinnerIsOurTeam = tableLeaderTeams.size === 1
                ? [...tableLeaderTeams][0] === 0 : null;
            this.cardsThatBeatTable = this.tableStrongestCard ? this.cards.filter(c => GameRules.canBeat(c, this.tableStrongestCard)).length : this.totalCards;
            this.cardsThatTieTable = this.tableStrongestCard
                ? this.cards.filter(c => GameRules.compare(c, this.tableStrongestCard) === 0).length : 0;
            const viradaCount = this.turnedCard ? 1 : 0;
            const cartasRodadaAtual = this.tableCards.length;
            const rodadasPelaMemoria = Math.floor(Math.max(0,
                this.seenCards.size - viradaCount - cartasRodadaAtual) / 4);
            this.rodadasCompletas = Math.min(2,
                Math.max(RoundState.roundsCompleted, rodadasPelaMemoria));
            this.rodadasNossa = RoundState.tricksWon[0];
            this.rodadasEles = RoundState.tricksWon[1];
            this.rodadasEmpatadas = RoundState.roundsTied;
            this.minhaPosicaoNaRodada = Utils.clamp(this.tableCards.length + 1, 1, 4);
            this.probability = ProbabilityAnalyzer.estimate(this);
            this.winChance = this.probability.winChance;
            this.safeCards = this.probability.safeCards;
            this.placar = snapshot.placar || ScoreReader.read();

            // Estatísticas combinadas (mão de 10)
            if (this.isMao10 && this.mao10Parceiro.length > 0) {
                const todasCartas = [...this.cards, ...this.mao10Parceiro];
                this.manilhasCombinadas = todasCartas.filter(c => GameRules.isManilha(c)).length;
                this.forcaCombinada = todasCartas.reduce((s, c) => s + GameRules.strength(c), 0);
                this.mediaCombinada = todasCartas.length ? +(this.forcaCombinada / todasCartas.length).toFixed(1) : 0;
                this.cartasFortes = todasCartas.filter(c => GameRules.isCartaForte(c)).length;
                this.cartasAltasCombinadas = todasCartas.filter(c => GameRules.strength(c) >= 9).length;
            } else {
                this.manilhasCombinadas = this.manilhas;
                this.forcaCombinada = this.totalStrength;
                this.mediaCombinada = this.averageStrength;
                this.cartasFortes = this.cards.filter(c => GameRules.isCartaForte(c)).length;
                this.cartasAltasCombinadas = this.cards.filter(c => GameRules.strength(c) >= 9).length;
            }
            this.mao10Analysis = this.isMao10
                ? ProbabilityAnalyzer.estimateDuoHand(this.cards, this.mao10Parceiro)
                : { complete: false, winChance: 0, safeTricks: 0, profile: [] };

            // 🆕 Score único usado pelo DecisionEngine (calculado por último,
            // pois depende de manilhasCombinadas/cartasFortes/winChance/safeCards).
            this.handScore = GameRules.handScore(this);
            this.rodadaAtual = Utils.clamp(this.rodadasCompletas + 1, 1, 3);
            this.contextualScore = GameRules.contextualScore(this);
        }
        static fromReader(r) { return new GameState(r.getState()); }
        strongestCard() { return this.cards.reduce((b, c) => !b ? c : (GameRules.strength(c) > GameRules.strength(b) ? c : b), null); }
        weakestCard() { return this.cards.reduce((w, c) => !w ? c : (GameRules.strength(c) < GameRules.strength(w) ? c : w), null); }
    }

    // =====================
    // DECISION ENGINE (🆕 reescrito em cima do handScore unificado)
    // =====================
    const DecisionEngine = {
        analyze(state) {
            // Responder ao popup tem prioridade sobre a leitura das cartas:
            // no pedido ao parceiro o jogo pode ocultar a mão temporariamente,
            // mas o comando de opinião ainda precisa ser enviado.
            if (state.isTrucoPending && state.trucoQuemPediu === 'eles') {
                return this.decidirRespostaTruco(state);
            }
            if (state.inputIncomplete) {
                return { suggestion: "AGUARDAR", label: "LENDO", confidence: 0, reason: `Lendo cartas: mesa ${state.tableCards.length}/${state.tableElementCount}, mão ${state.cards.length}/${state.handElementCount}.` };
            }
            if (!state.totalCards) return { suggestion: "AGUARDAR", label: "--", confidence: 0, reason: "Aguardando cartas." };
            if (state.rodadasNossa >= 2 || state.rodadasEles >= 2) {
                return { suggestion: "AGUARDAR", label: "--", confidence: 0, reason: "Mão encerrada; aguardando atualização do placar." };
            }

            if (state.isMao10) {
                return this.decidirMao10(state);
            }

            return this.decidirNormal(state);
        },

        decidirRespostaTruco(state) {
            const p = state.placar;
            const valor = TrucoState.getValorText();
            let score = state.contextualScore;
            const ajustePerfil = OpponentModel.bluffAdjustment();
            const perfil = OpponentModel.summary();
            const ajustePlacar = GameRules.scoreAggressionModifier(p);
            score += ajustePerfil + Math.round(ajustePlacar * 0.5);

            // O placar ajusta o quanto vale a pena arriscar: perdendo, comprime a
            // exigência; ganhando confortavelmente, segura mais a mão.
            if (p.pertoDePerder) score += 6;
            if (p.pertoDeGanhar && p.diferenca >= Config.placarLimits.vantagemParaNaoArriscar) score -= 6;
            score = Utils.clamp(score, 0, 100);

            // Tres cartas altas podem valer mais que o score probabilistico,
            // especialmente quando a simulacao ainda tem poucas cartas vistas.
            // Ex.: 3, 2, 2 e uma mao para brigar, nao para correr automaticamente.
            const forcas = state.cards.map(c => GameRules.strength(c)).sort((a, b) => b - a);
            const duasAltas = forcas.length >= 2 && forcas[0] >= 9 && forcas[1] >= 9;
            const duasVitorias = forcas.length >= 2 && forcas[0] >= 9 && forcas[1] >= 8;
            const recursosDeVitoria = forcas.filter(forca => forca >= 8).length;
            const maoMuitoFraca = recursosDeVitoria === 0;
            const parceiroTemManilhaVencedora = state.tableWinnerIsOurTeam === true
                && state.tableStrongestCard
                && GameRules.isManilha(state.tableStrongestCard)
                && [0, 2].includes(state.tableStrongestCard.playerPosition);
            if (parceiroTemManilhaVencedora && TrucoState.getValorPontos() <= 4 && !p.pertoDePerder) {
                return {
                    suggestion: "ACEITAR_TRUCO",
                    label: "ACEITAR",
                    confidence: 91,
                    reason: `Parceiro controla ${state.tableStrongestCard.nome}${state.tableStrongestCard.naipe}, uma manilha vencedora; aceitar o Truco em ${p.nos}x${p.eles}.`,
                };
            }
            if (duasAltas) score = Math.max(score, 64);
            else if (duasVitorias) score = Math.max(score, 58);
            if (p.pertoDeGanhar && p.diferenca >= 6 && duasAltas) score = Math.max(score, 78);
            const opiniao = state.partnerOpinion;
            if (opiniao?.action === "CORRER") score -= 12;
            else if (opiniao?.action === "ACEITAR") score += 10;
            else if (opiniao?.action === "AUMENTAR") score += 18;
            score = Utils.clamp(score, 0, 100);
            const motivoOpiniao = opiniao
                ? ` Parceiro opinou ${opiniao.action.toLowerCase()}${opiniao.value ? ` (${opiniao.value})` : ""}.`
                : "";
            const motivoPerfil = perfil && perfil.sample >= 3
                ? ` Perfil ${perfil.style}, ${perfil.sample} resultados, ajuste ${ajustePerfil >= 0 ? "+" : ""}${ajustePerfil}.`
                : " Perfil ainda sem amostra suficiente.";

            const valorPedido = state.trucoValor || TrucoState.getValorPontos();
            const falta = Math.max(1, Config.placarLimits.maxTentos - p.nos);
            const botaoAumento = Utils.$(Config.selectors.popupTrucoAumentar);
            const temZap = state.cards.some(card => card.nome === "4" && card.naipe === "â™£");
            const temDoisOuTres = state.cards.some(card => ["2", "3"].includes(card.nome));
            if (valorPedido <= 4 && temZap && temDoisOuTres && botaoAumento
                && Utils.isVisible(botaoAumento) && valorPedido < falta
                && !(p.pertoDeGanhar && p.diferenca >= 6)) {
                Logger.info("Contra-truco forte: Zap acompanhado de 2 ou 3.");
                return {
                    suggestion: "AUMENTAR_TRUCO",
                    label: "AUMENTAR",
                    confidence: 98,
                    featureTag: "CONTRA_TRUCO_FATAL",
                    reason: "Zap e 2/3 disponiveis; aumentar enquanto o valor ainda cabe no placar.",
                };
            }
            let limiteAceitar = valorPedido <= 4 ? 50
                : valorPedido <= 8 ? 60
                : valorPedido <= 10 ? 72 : 82;
            if (state.rodadasNossa > state.rodadasEles) limiteAceitar -= 8;
            if (state.tableWinnerIsOurTeam === true) limiteAceitar -= 6;
            if (p.pertoDePerder) limiteAceitar -= 4;
            if (p.diferenca >= 6 && duasAltas) limiteAceitar -= 6;
            const pisoAceitar = valorPedido <= 4 ? 52
                : valorPedido <= 8 ? 62
                : valorPedido <= 10 ? 74 : 84;
            limiteAceitar = Utils.clamp(limiteAceitar, pisoAceitar, 88);

            // Uma mão sem A, 2, 3 ou manilha não deve aceitar Truco apenas
            // porque o placar ou a mesa reduziram o limite matemático. A
            // exceção é quando o parceiro controla claramente a vaza ou
            // expressou que aceita.
            const parceiroDaDuplaVence = state.tableWinnerIsOurTeam === true;
            if (maoMuitoFraca && !parceiroDaDuplaVence && opiniao?.action !== "ACEITAR") {
                return {
                    suggestion: "CORRER_TRUCO",
                    label: "CORRER",
                    confidence: Utils.clamp(100 - score, 68, 95),
                    reason: `Mão sem carta de cobertura (A/2/3 ou manilha), score ${score}/100. Correr.${motivoOpiniao}`,
                };
            }

            const aumentar = Utils.$(Config.selectors.popupTrucoAumentar);
            const valorAumento = aumentar ? Utils.parseTrucoValue(aumentar.textContent, 0) : 0;
            const margemAumento = opiniao?.action === "AUMENTAR" ? 5 : 20;
            if (aumentar && Utils.isVisible(aumentar) && valorAumento > 0
                && valorPedido < falta && score >= limiteAceitar + margemAumento) {
                return { suggestion: "AUMENTAR_TRUCO", label: "AUMENTAR", confidence: score,
                    reason: `Score atual ${score}/100 permite aumentar para ${valorAumento}.${motivoOpiniao}${motivoPerfil}` };
            }

            if (score >= limiteAceitar) {
                return {
                    suggestion: "ACEITAR_TRUCO",
                    label: "ACEITAR",
                    confidence: Utils.clamp(55 + (score - limiteAceitar), 55, 97),
                    reason: `Score atual ${score}/100 supera o limite ${limiteAceitar} para ${valor}.${motivoOpiniao}${motivoPerfil}`,
                };
            }
            return {
                suggestion: "CORRER_TRUCO",
                label: "CORRER",
                confidence: Utils.clamp(55 + (limiteAceitar - score), 55, 95),
                reason: `Score atual ${score}/100 abaixo do limite ${limiteAceitar} para ${valor}.${motivoOpiniao}${motivoPerfil}`,
            };
        },

        decidirMao10(state) {
            const analysis = state.mao10Analysis;
            if (!analysis.complete) {
                return {
                    suggestion: "AGUARDAR",
                    label: "LENDO",
                    confidence: 0,
                    reason: `Mão de 10 incompleta: ${state.cards.length} suas + ${state.mao10Parceiro.length} do parceiro.`
                };
            }

            const cartasDaDupla = [...state.cards, ...state.mao10Parceiro];
            const nenhumaCartaForte = !cartasDaDupla.some(card => GameRules.strength(card) >= 8);
            if (nenhumaCartaForte) {
                return {
                    suggestion: "CORRER_MAO10",
                    label: "CORRER",
                    confidence: 90,
                    featureTag: "FUGA_MAO10_LIXO",
                    reason: "Mao de 10 sem carta de cobertura; fuga tatica para preservar tentos.",
                };
            }

            let limiteJogar = RuntimeConfig.limiteMao10Inicial;
            if (state.placar.eles >= 8) limiteJogar -= 6;
            if (state.placar.eles >= 10) limiteJogar -= 5;
            if (state.manilhasCombinadas >= 1) limiteJogar -= 4;
            if (state.cartasAltasCombinadas >= 2) limiteJogar -= 3;
            limiteJogar = Utils.clamp(limiteJogar, 35, 55);

            const forcarJogo = state.manilhasCombinadas >= 2
                || (state.manilhasCombinadas >= 1 && state.cartasAltasCombinadas >= 2)
                || analysis.safeTricks >= 2;
            const jogar = forcarJogo || analysis.winChance >= limiteJogar;
            const distancia = Math.abs(analysis.winChance - limiteJogar);
            return {
                suggestion: jogar ? "JOGAR_MAO10" : "CORRER_MAO10",
                label: jogar ? "JOGAR" : "CORRER",
                confidence: Utils.clamp(55 + distancia, 55, 96),
                reason: `Mão de 10 completa: ${analysis.winChance}% para duas vazas, limite ${limiteJogar} (${state.manilhasCombinadas} manilhas, ${state.cartasAltasCombinadas} cartas 2/3 ou melhores).`
            };
        },

        decidirNormal(state) {
            const p = state.placar;
            let score = state.contextualScore;
            score = Utils.clamp(score, 0, 100);
            const botaoTruco = Utils.$("#trucoAumentar");
            const valorAtual = TrucoState.getValorPontos();
            const pontosParaVencer = Math.max(1, Config.placarLimits.maxTentos - p.nos);
            const podeAumentar = botaoTruco && Utils.isVisible(botaoTruco)
                && valorAtual < pontosParaVencer;
            const ajustePlacar = GameRules.scoreAggressionModifier(p);
            let limiteTruco = valorAtual <= 2 ? RuntimeConfig.limiteTrucoInicial
                : valorAtual <= 4 ? 78
                : valorAtual <= 8 ? 86 : 93;
            limiteTruco -= ajustePlacar;
            const cartasDominantes = state.cards
                .filter(card => GameRules.strength(card) >= 9);
            const primeiraVaza = state.rodadasCompletas === 0;
            const temZap = state.cards.some(card => card.nome === "4" && card.naipe === "â™£");
            const temSeteCopas = state.cards.some(card => card.nome === "7" && card.naipe === "â™¥");
            const forcaAbsolutaParaTruco = cartasDominantes.length >= 2;
            // Com 8 ou mais pontos e vantagem ampla, uma mao media nao deve
            // transformar uma vitoria quase garantida em risco. Neste cenario
            // so liberamos o pedido com duas cartas dominantes ou uma manilha
            // acompanhada de outra carta realmente alta.
            const placarPertoDeFechar = p.nos >= 8 && p.diferenca >= 8;
            const forcaParaArriscarNoFim = forcaAbsolutaParaTruco
                || (state.manilhas >= 1 && cartasDominantes.length >= 1);
            const bloquearTrucoPorPlacar = placarPertoDeFechar && !forcaParaArriscarNoFim;
            const baseMinimaNaPrimeira = !primeiraVaza
                || forcaAbsolutaParaTruco
                || state.manilhas >= 2
                || score >= 82;
            if (primeiraVaza && state.tableCards.length === 0 && temZap && temSeteCopas
                && podeAumentar && !bloquearTrucoPorPlacar
                && !(p.pertoDeGanhar && p.diferenca >= 6)) {
                Logger.info("Truco dupla manilha: Zap e 7 de Copas na abertura.");
                return {
                    suggestion: "PEDIR_TRUCO",
                    label: "TRUCAR",
                    confidence: 98,
                    featureTag: "TRUCO_DUPLA_MANILHA",
                    reason: "Zap e 7 de Copas disponiveis na abertura; pressionar enquanto o placar permite.",
                };
            }
            const matadorNoPe = state.rodadaAtual === 3
                && state.tableCards.length === 3
                && state.rodadasNossa === 1
                && state.rodadasEles === 1
                && state.cardsThatBeatTable > 0
                && state.tableWinnerIsOurTeam !== true;
            if (matadorNoPe && podeAumentar && !bloquearTrucoPorPlacar) {
                Logger.info("Truco matador no pe: terceira vaza garantida antes da carta.");
                return {
                    suggestion: "PEDIR_TRUCO",
                    label: "TRUCAR",
                    confidence: 100,
                    featureTag: "TRUCO_MATADOR_PE",
                    reason: "Terceira vaza empatada; ultima jogada tem carta vencedora.",
                };
            }
            const cangaNaSegundaVaza = state.rodadasEmpatadas > 0
                && state.rodadaAtual === 2
                && state.tableCards.length === 0;
            const cartaRazoavelParaCanga = state.cards.some(card => GameRules.strength(card) >= 8);
            if (cangaNaSegundaVaza && cartaRazoavelParaCanga && podeAumentar
                && !bloquearTrucoPorPlacar && !p.pertoDeGanhar) {
                Logger.info("Truco de canga: pressionando antes da segunda vaza.");
                return {
                    suggestion: "PEDIR_TRUCO",
                    label: "TRUCAR",
                    confidence: 90,
                    featureTag: "TRUCO_DE_CANGA",
                    reason: "A primeira vaza empatou; carta razoavel disponivel para pressionar na segunda.",
                };
            }
            const ultimaJogadaDaVaza = state.minhaPosicaoNaRodada === 4;
            const maiorMesaEAdversario = state.tableStrongestCard
                && ![0, 2].includes(state.tableStrongestCard.playerPosition);
            if (ultimaJogadaDaVaza && maiorMesaEAdversario && state.cardsThatBeatTable > 0) {
                const vencedoras = state.cards
                    .filter(card => GameRules.canBeat(card, state.tableStrongestCard))
                    .sort((a, b) => GameRules.strength(a) - GameRules.strength(b));
                if (vencedoras.length) {
                    return {
                        suggestion: "JOGAR",
                        label: "COBRIR",
                        confidence: 96,
                        reason: `Ultima jogada: maior carta adversaria e ${state.tableStrongestCard.nome}${state.tableStrongestCard.naipe}; cobrir com ${vencedoras[0].nome}${vencedoras[0].naipe}.`,
                    };
                }
            }
            if (state.rodadasNossa > state.rodadasEles) limiteTruco -= 7;
            if (state.tableWinnerIsOurTeam === true) limiteTruco -= 5;
            if (state.manilhas >= 1) limiteTruco -= 4;
            if (state.safeCards >= 2) limiteTruco -= 3;
            if (p.pertoDePerder) limiteTruco -= 2;
            if (p.pertoDeGanhar && p.diferenca >= Config.placarLimits.vantagemParaNaoArriscar) {
                limiteTruco += 5;
            }
            limiteTruco = Utils.clamp(limiteTruco, 62, 95);

            if (state.tableStrongestCard && state.tableWinnerIsOurTeam === true) {
                if (podeAumentar && !bloquearTrucoPorPlacar && baseMinimaNaPrimeira
                    && (forcaAbsolutaParaTruco || score >= limiteTruco)) {
                    return { suggestion: "PEDIR_TRUCO", label: "TRUCAR", confidence: Utils.clamp(score, 65, 96),
                        reason: `Parceiro vence a mesa; ${cartasDominantes.length} cartas dominantes e score ${score}/100.` };
                }
                return { suggestion: "JOGAR", label: "PRESERVAR", confidence: 88,
                    reason: `Parceiro vence a mesa na rodada ${state.rodadaAtual}; descartar a menor carta.` };
            }
            if (state.tableStrongestCard && state.cardsThatBeatTable === 0
                && state.cardsThatTieTable > 0 && state.rodadasNossa > state.rodadasEles) {
                return { suggestion: "JOGAR", label: "EMPATAR", confidence: 86,
                    featureTag: "EMPATE_VITORIOSO_R2",
                    reason: `O empate preserva a vantagem conquistada nas rodadas anteriores.` };
            }
            if (state.tableStrongestCard && state.cardsThatBeatTable === 0) {
                return { suggestion: "JOGAR", label: "DESCARTAR", confidence: state.winChance < 35 ? 88 : 72,
                    reason: `Nenhuma carta cobre a mesa na rodada ${state.rodadaAtual}; preservar as maiores.` };
            }
            if (podeAumentar && !bloquearTrucoPorPlacar && baseMinimaNaPrimeira
                && (forcaAbsolutaParaTruco || score >= limiteTruco)) {
                return {
                    suggestion: "PEDIR_TRUCO",
                    label: "TRUCAR",
                    confidence: Utils.clamp(score, 65, 96),
                    reason: `${cartasDominantes.length} cartas dominantes; força ${score}/100 para aumentar a ${GameRules.nextTrucoValue(valorAtual)} pontos.`
                };
            }
            if (p.pertoDeGanhar && p.diferenca >= Config.placarLimits.vantagemParaNaoArriscar) {
                return { suggestion: "JOGAR", label: "JOGAR", confidence: 90,
                    reason: bloquearTrucoPorPlacar
                        ? `Placar ${p.nos}x${p.eles}: mao sem cobertura para arriscar; preservar a vantagem.`
                        : `Ganhando por ${p.diferenca}. Segurar o jogo, sem arriscar.` };
            }
            if (score <= 30) {
                return { suggestion: "JOGAR", label: "CAUTELA", confidence: 78,
                    reason: `Mao fraca (score ${score}/100); jogar sem aumentar e preservar a melhor carta.` };
            }
            return { suggestion: "JOGAR", label: "JOGAR", confidence: 55, reason: `Mão mediana (score ${score}/100, ${state.winChance}% vitória).` };
        },
    };

    // =====================
    // ACTIONS
    // =====================
    class Actions {
        constructor(reader) { this.reader = reader; }
        clickFirstVisible(ids) { return ids.some(id => { const b = document.getElementById(id); if (!Utils.isVisible(b)) return false; return Utils.dispatchHumanClick(b); }); }
        sendNative(action) {
            const con = PageWindow.con;
            if (typeof con?.envioMsgJogo !== "function") return false;

            // O popup de opiniao do parceiro tem outro comando no jogo:
            // 31 = apoio, enquanto 28/29 sao aceitar/correr para nos mesmos.
            let message = Config.nativeMessages[action];
            if (TrucoState.paraParceiro && ["accept", "run", "truco"].includes(action)) {
                const apoio = action === "run" ? 0 : action === "accept" ? 1 : 2;
                message = { code: 31, payload: { apoio } };
            }
            if (!message) return false;
            con.envioMsgJogo(message.code, message.payload);
            Logger.info(`Ação ${action} via API (${message.code}).`, message.payload);
            return true;
        }
        execute(action) { return this.sendNative(action) || this.clickFirstVisible(Config.actionButtonIds[action]); }

        truco() {
            const botao = Utils.$(Config.selectors.popupTrucoAumentar);
            const botaoNormal = Utils.$("#trucoAumentar");
            const podeEnviar = (botao && Utils.isVisible(botao))
                || (botaoNormal && Utils.isVisible(botaoNormal));
            if (!podeEnviar) {
                Logger.info("Pedido de aumento ignorado: controle de truco indisponivel.");
                return false;
            }
            const valor = botao && Utils.isVisible(botao)
                ? Utils.parseTrucoValue(botao.textContent, GameRules.nextTrucoValue(TrucoState.getValorPontos()))
                : GameRules.nextTrucoValue(TrucoState.getValorPontos());
            const placar = ScoreReader.read();
            const pontosParaVencer = Math.max(1, Config.placarLimits.maxTentos - placar.nos);
            const valorAtual = TrucoState.getValorPontos();
            // Se o valor atual ja fecha o jogo, aumentar so adiciona risco.
            // Se ainda nao fecha, o proximo degrau pode ultrapassar os pontos
            // faltantes e mesmo assim ser o menor aumento disponivel.
            if (valorAtual >= pontosParaVencer) {
                Logger.info(`Aumento bloqueado: o valor atual ${valorAtual} ja fecha os ${pontosParaVencer} pontos restantes.`);
                return false;
            }
            // O botao de aumento pode existir no DOM antes de estar realmente
            // habilitado; a mensagem nativa e a forma mais confiavel para
            // pedir truco, com clique apenas como fallback.
            const opinandoParceiro = TrucoState.paraParceiro;
            const r = this.sendNative("truco") || this.clickFirstVisible(Config.actionButtonIds.truco);
            if (r && opinandoParceiro) TrucoState.aceitar();
            else if (r) TrucoState.pedir(valor);
            return r;
        }
        accept() { const r = this.execute("accept"); if (r) TrucoState.aceitar(); return r; }
        run() {
            const opinandoParceiro = TrucoState.paraParceiro;
            const r = this.execute("run");
            if (r && opinandoParceiro) TrucoState.aceitar();
            else if (r) TrucoState.correr();
            return r;
        }
        turn() { return this.clickFirstVisible(Config.actionButtonIds.turn); }
        mao10Jogar() { const r = this.execute("mao10Jogar"); if (r) Mao10State.fechar(); return r; }
        mao10Correr() { const r = this.execute("mao10Correr"); if (r) Mao10State.fechar(); return r; }
        jogarCarta(carta, encoberta = null) {
            if (!carta) {
                Logger.warn("Jogar carta abortado: carta inexistente.");
                return false;
            }
            const virada = encoberta ?? (Utils.$("#acoesCartaVirada")?.classList.contains("active") || false);
            const con = PageWindow.con;
            const payload = { carta: carta.codigo, encoberta: virada, posicao: carta.posicao };
            const cartaAindaNaMao = this.reader.getHandCards()
                .some(atual => atual.codigo === carta.codigo);
            if (!cartaAindaNaMao) {
                Logger.warn("Guard Rail: carta escolhida nao esta mais na mao; envio cancelado.", payload);
                return false;
            }
            Logger.info("Jogar carta iniciado:", {
                nome: carta.nome, naipe: carta.naipe, codigo: carta.codigo,
                posicao: carta.posicao, virada, conDisponivel: typeof con?.envioMsgJogo === "function",
            });
            if (typeof con?.envioMsgJogo === "function" && carta.codigo) {
                try {
                    con.envioMsgJogo(30, payload);
                    Logger.info("Carta enviada via API:", payload);
                    return true;
                } catch (error) {
                    Logger.error("Falha ao enviar carta pela API:", { payload, message: error?.message || error, stack: error?.stack });
                    return false;
                }
            }
            Logger.warn("Conexao nativa indisponivel ou carta sem codigo:", {
                conDisponivel: typeof con?.envioMsgJogo === "function", codigo: carta.codigo,
            });
            return false;
        }
        escolherCarta(s) {
            const elementosMesa = this.reader.cache.all(Config.selectors.tableCards)
                .filter(el => Utils.isVisible(el));
            const existeMesa = elementosMesa.length > 0;
            if (elementosMesa.length > s.tableCards.length) {
                Logger.warn("Mesa incompleta: elementos visiveis", elementosMesa.length,
                    "cartas decodificadas", s.tableCards.length,
                    elementosMesa.map(el => ({ classe: el.className, estilo: el.getAttribute("style") })));
                return null;
            }
            const cartas = s.cards.slice().sort((a, b) => GameRules.strength(a) - GameRules.strength(b));
            if (!existeMesa) {
                // No Mineiro, canga na primeira vaza faz a segunda decidir a
                // mao. Nao economizar a maior carta nesse estado.
                if (s.rodadasEmpatadas > 0 && s.rodadasCompletas === 1) {
                    Logger.info("Canga na primeira vaza: jogar a maior carta para decidir a mao.");
                    return cartas[cartas.length - 1];
                }
                // Se a Mao de 10 revelou uma carta forte do parceiro, a
                // abertura deve coordenar as duas maos: tentar a vaza com
                // uma carta alta comum e preservar a manilha para cobrir a
                // segunda ou a terceira vaza. Ex.: Zap + 2 nosso e 2 do
                // parceiro -> abrir de 2, nao gastar o Zap.
                if (s.rodadasCompletas === 0 && s.planejamentoParceiro.length) {
                    const parceiroTemForte = s.planejamentoParceiro.some(card =>
                        GameRules.isManilha(card) || GameRules.strength(card) >= 9);
                    const zap = cartas.find(card => card.nome === "4" && card.naipe === "♣");
                    const dois = cartas.find(card => card.nome === "2");
                    if (parceiroTemForte && zap && dois && GameRules.strength(zap) > GameRules.strength(dois)) {
                        Logger.info("Plano M10: preservar Zap; abertura com 2 para coordenar a carta forte do parceiro.");
                        return dois;
                    }
                }
                const manilhasNaMao = cartas.filter(card => GameRules.isManilha(card));
                const cartasComuns = cartas.filter(card => !GameRules.isManilha(card));
                const duasCartasFracas = cartasComuns.length >= 2
                    && GameRules.strength(cartasComuns[cartasComuns.length - 1]) <= 6;
                // Sem informacao confiavel do parceiro, a unica manilha deve
                // ser mantida como resposta para uma carta forte da mesa.
                // Abrir de Zap garante uma vaza, mas elimina a melhor defesa
                // das duas vazas seguintes quando as outras cartas sao lixo.
                if (s.rodadasCompletas === 0 && manilhasNaMao.length === 1 && duasCartasFracas) {
                    Logger.info("Abertura conservadora: preservar a unica manilha e testar com carta baixa.");
                    return cartasComuns[0];
                }
                // Na terceira rodada nao ha mais motivo para esconder forca.
                if (s.rodadasCompletas >= 2) return cartas[cartas.length - 1];
                // Se estamos atras na mao, a abertura deve tentar recuperar
                // a rodada com a melhor carta disponivel.
                if (s.rodadasEles > s.rodadasNossa) return cartas[cartas.length - 1];
                // Na segunda rodada, a escolha depende do resultado atual. Se
                // estamos atras, recuperar exige forca; se ja vencemos,
                // descartamos a menor e guardamos as cartas decisivas.
                if (s.rodadasCompletas >= 1) {
                    if (s.rodadasEles > s.rodadasNossa) return cartas[cartas.length - 1];
                    if (s.rodadasNossa > s.rodadasEles) return cartas[0];
                    // Quando a propriedade da rodada ainda nao foi identificada,
                    // uma mao forte conserva o topo; uma mao fragil disputa a
                    // rodada com a melhor carta restante.
                    return s.contextualScore >= 72
                        ? cartas[Math.max(0, cartas.length - 2)]
                        : cartas[cartas.length - 1];
                }
                // Na abertura, a carta intermediaria mede a mesa sem gastar o
                // topo nem entregar a rodada com o pior descarte.
                if (cartas.length >= 3) return cartas[1];
                return cartas[cartas.length - 1];
            }
            const parceiroAindaNaoJogou = !s.tableCards.some(card => card.playerPosition === 2);
            const venceuPrimeira = s.rodadasEles > s.rodadasNossa;
            const vencedorasMesa = s.tableStrongestCard
                ? cartas.filter(card => GameRules.canBeat(card, s.tableStrongestCard))
                : [];
            const unicaCoberturaEManilha = vencedorasMesa.length > 0
                && vencedorasMesa.every(card => GameRules.isManilha(card));
            if (venceuPrimeira && parceiroAindaNaoJogou && s.tableCards.length < 3
                && unicaCoberturaEManilha && cartas.length > vencedorasMesa.length) {
                Logger.info("Segunda vaza sob risco: preservar manilha e jogar carta pequena para o parceiro cobrir.");
                return cartas.find(card => !GameRules.isManilha(card)) || cartas[0];
            }
            if (!s.tableStrongestCard || s.tableWinnerIsOurTeam === true) return cartas[0];
            const vencedoras = cartas.filter(c => GameRules.canBeat(c, s.tableStrongestCard));
            const empates = cartas.filter(c => GameRules.compare(c, s.tableStrongestCard) === 0);
            if (s.rodadasNossa > s.rodadasEles && empates.length) {
                return empates[0];
            }
            // Primeiro tenta vencer com carta comum. Manilha so entra quando
            // nenhuma carta comum consegue matar a mesa.
            const comuns = vencedoras.filter(c => !GameRules.isManilha(c));
            return comuns[0] || vencedoras[0] || cartas[0];
        }
        playBest() {
            const s = GameState.fromReader(this.reader);
            if (!s.cards.length || s.inputIncomplete) {
                Logger.info("Auto-jogada aguardando a leitura completa das cartas.");
                return false;
            }
            const cartaInteligente = this.escolherCarta(s);
            if (!cartaInteligente) {
                Logger.warn("Auto-jogada pausada ate a mesa ser lida completamente.");
                return false;
            }
            Logger.info("Decisao contextual:", cartaInteligente.nome, cartaInteligente.naipe,
                "mesa:", s.tableCards.map(card => `${card.nome}${card.naipe}`).join(",") || "vazia",
                "nossaDuplaVence:", s.tableWinnerIsOurTeam,
                "vencedoras:", s.tableStrongestCard
                    ? s.cards.filter(c => GameRules.canBeat(c, s.tableStrongestCard))
                        .map(c => `${c.nome}${c.naipe}${GameRules.isManilha(c) ? "*" : ""}`).join(",")
                    : "-");
            const controleVirar = Utils.$("#acoesCartaVirada");
            const podeOcultar = controleVirar && Utils.isVisible(controleVirar);
            const ganhouPrimeira = s.rodadasNossa === 1 && s.rodadasCompletas === 1;
            const cartaFraca = GameRules.strength(cartaInteligente) <= 5;
            if (ganhouPrimeira && cartaFraca && podeOcultar && s.tableCards.length === 0) {
                Logger.info("Carta virada tatica: ganhamos a primeira vaza e preservamos a carta forte.");
                DatasetCollector.tagLastFeature("VIRADA_TATICA");
                return this.jogarCarta(cartaInteligente, true);
            }
            const rodadaPerdida = s.tableStrongestCard
                && s.cardsThatBeatTable === 0
                && !(s.cardsThatTieTable > 0 && s.rodadasNossa > s.rodadasEles);
            return this.jogarCarta(cartaInteligente,
                Boolean(podeOcultar && rodadaPerdida && s.cards.length > 1));
        }
        playWorst() { const s = GameState.fromReader(this.reader); const c = s.weakestCard(); if (!c) return false; Logger.info("Pior:", c.nome, c.naipe); return this.jogarCarta(c); }
        resetAssistant() {
            TrucoState.reset();
            Mao10State.reset();
            RoundState.reset();
            MemoryTracker.reset();
            ScoreReader._nossaCor = null;
            this.reader.cache.invalidate();
            Logger.info("Estado do assistente zerado manualmente.");
        }
    }

    // =====================
    // UI
    // =====================
    class UI {
        constructor(actions) { this.actions = actions; this.wrapper = null; this.minimized = false; this.lastRenderTime = 0; }
        mount() {
            if (document.getElementById(Config.ids.wrapper)) return;
            this.injectStyles();
            this.wrapper = document.createElement("div");
            this.wrapper.id = Config.ids.wrapper;
            this.wrapper.innerHTML = `
<div id="${Config.ids.panel}">
  <div id="${Config.ids.header}">
    <span class="truco-drag-dots" aria-hidden="true">⠿</span>
    <h3>🃏 ${Config.appName}</h3>
    <div class="truco-header-actions">
      <button type="button" class="truco-btn-header" id="${Config.ids.minimize}" title="Minimizar">–</button>
      <button type="button" class="truco-btn-header" id="${Config.ids.close}" title="Fechar">✕</button>
    </div>
  </div>
  <div id="${Config.ids.content}">
    <button type="button" class="truco-sugestao" id="${Config.ids.suggestion}">
      <span class="truco-sugestao-label">--</span>
      <span class="truco-sugestao-sub">Clique para analisar</span>
    </button>
    <div class="truco-info" id="${Config.ids.analysis}">🃏 Aguardando cartas...</div>
    <div class="truco-botoes truco-botoes-zerar">
      <button type="button" class="truco-btn truco-btn-reset" id="${Config.ids.reset}"><span class="truco-btn-ic">↺</span><span>Zerar</span></button>
    </div>
    <div class="truco-toggles">
      <label class="truco-switch-label"><input type="checkbox" id="${Config.ids.autoAnalyze}"><span class="truco-switch"></span><span>📊 Auto-analisar</span></label>
      <label class="truco-switch-label"><input type="checkbox" id="${Config.ids.autoPlay}"><span class="truco-switch"></span><span>🤖 Auto-jogar</span></label>
    </div>
    <div class="truco-status" id="${Config.ids.status}">Sniffer WS ativo!</div>
  </div>
</div>`;
            document.body.appendChild(this.wrapper);
            this.bindControls();
            this.enableDrag();
        }
        bindControls() {
            this.get(Config.ids.reset).onclick = () => this.resetPanel();
            this.get(Config.ids.minimize).onclick = () => this.toggleMinimized();
            this.get(Config.ids.close).onclick = () => this.hideWithRestoreButton();
        }
        get(id) { return document.getElementById(id); }
        resetPanel() {
            this.actions.resetAssistant();
            const autoAnalyze = this.get(Config.ids.autoAnalyze);
            const autoPlay = this.get(Config.ids.autoPlay);
            if (autoAnalyze) autoAnalyze.checked = false;
            if (autoPlay) autoPlay.checked = false;
            const a = this.get(Config.ids.analysis), s = this.get(Config.ids.suggestion), st = this.get(Config.ids.status);
            if (a) a.innerHTML = "🃏 Aguardando cartas...";
            if (s) {
                s.innerHTML = `<span class="truco-sugestao-label">--</span><span class="truco-sugestao-sub">Clique para analisar</span>`;
                s.className = "truco-sugestao";
            }
            if (st) st.innerHTML = `<span class="truco-chip">Placar 0x0</span><span class="truco-chip">Tento 2</span><div class="truco-status-reason">Estado zerado. Ative auto-analisar/auto-jogar ao entrar em outra partida.</div>`;
            document.dispatchEvent(new CustomEvent("truco:reset-panel"));
        }
        render(state, decision) {
            const a = this.get(Config.ids.analysis), s = this.get(Config.ids.suggestion), st = this.get(Config.ids.status);
            if (!state.totalCards) {
                a.innerHTML = "🃏 Aguardando cartas...";
                s.innerHTML = `<span class="truco-sugestao-label">--</span><span class="truco-sugestao-sub">Clique para analisar</span>`;
                s.className = "truco-sugestao";
                return;
            }
            a.innerHTML = this.renderAnalysis(state);
            const confidenceText = decision.suggestion === "AGUARDAR"
                ? "Aguardando leitura"
                : `${decision.confidence}% de confiança`;
            s.innerHTML = `<span class="truco-sugestao-label">${decision.label}</span><span class="truco-sugestao-sub">${confidenceText}</span>`;
            s.className = `truco-sugestao ${decision.label}`;
            const p = state.placar;
            const chips = [];
            if (state.isMao10) chips.push({ t: "MÃO DE 10", cls: "truco-chip-warn" });
            if (state.isTrucoPending) chips.push({ t: TrucoState.getValorText().toUpperCase(), cls: "truco-chip-warn" });
            chips.push({ t: `Placar ${p.nos}x${p.eles}` });
            chips.push({ t: `Tento ${p.tentoAtual}` });
            if (p.times) chips.push({ t: `Nós: ${p.times.nossaCor}` });
            if (p.times) chips.push({ t: `Eles: ${p.times.corOponente}` });
            chips.push({ t: `Poder ${state.handPower}%` });
            chips.push({ t: `Rodada ${state.rodadaAtual}/3` });
            chips.push({ t: `Rodadas ${state.rodadasNossa}x${state.rodadasEles}${state.rodadasEmpatadas ? ` · ${state.rodadasEmpatadas} empate` : ""}` });
            chips.push({ t: `Score ${state.contextualScore}/100` });
            chips.push({ t: `Vitória ${state.winChance}%` });
            st.innerHTML = chips.map(c => `<span class="truco-chip${c.cls ? " " + c.cls : ""}">${c.t}</span>`).join("")
                + `<div class="truco-status-reason">${decision.reason}</div>`;
            this.lastRenderTime = Date.now();
        }
        cardHtml(c, extraClass = "", extraStyle = "") {
            const m = GameRules.isManilha(c);
            const vermelho = c.naipe === "♥" || c.naipe === "♦";
            const cls = ["truco-carta", m ? "truco-manilha" : (vermelho ? "truco-vermelha" : "truco-preta"), extraClass].join(" ").trim();
            const title = m ? ` title="${GameRules.manilhaName(c)}"` : "";
            const style = extraStyle ? ` style="${extraStyle}"` : "";
            return `<span class="${cls}"${title}${style}>${c.nome}${c.naipe}</span>`;
        }
        renderAnalysis(state) {
            let h = "";
            if (state.isTrucoPending) {
                h += `<div class="truco-alert">⚠️ ${TrucoState.getValorText()} pedido!</div>`;
            }
            h += `<div class="truco-section-title">${state.isMao10 ? "🃏 Mão de 10 — suas cartas" : "Suas cartas"}</div>`;
            h += `<div class="truco-cartas-row">${state.cards.map(c => this.cardHtml(c)).join("")}</div>`;

            if (state.isMao10 && state.mao10Parceiro.length > 0) {
                h += `<div class="truco-section-title">Cartas do parceiro</div>`;
                h += `<div class="truco-cartas-row">${state.mao10Parceiro.map(c => this.cardHtml(c, "truco-parceiro")).join("")}</div>`;
                h += `<div class="truco-note">Combinado: ${state.manilhasCombinadas} manilhas · ${state.cartasFortes} fortes · média ${state.mediaCombinada}/14 · duas vazas ${state.mao10Analysis.winChance}%</div>`;
            }

            if (state.tableCards.length) {
                h += `<div class="truco-section-title">Mesa</div>`;
                h += `<div class="truco-cartas-row">${state.tableCards.map(c => this.cardHtml(c, "truco-mesa")).join("")}</div>`;
            }
            if (state.turnedCard) h += `<div class="truco-note">Virada: ${state.turnedCard.nome}${state.turnedCard.naipe}</div>`;
            if (!state.isMao10 && state.tableStrongestCard) h += `<div class="truco-note">Cobrem: ${state.cardsThatBeatTable}/${state.totalCards} · empatam: ${state.cardsThatTieTable} · dupla vencendo: ${state.tableWinnerIsOurTeam === true ? "sim" : state.tableWinnerIsOurTeam === false ? "nao" : "incerto"}</div>`;
            if (!state.isMao10) h += `<div class="truco-note">Rodada ${state.rodadaAtual}/3 · Manilhas: ${state.manilhas} · Score atual: ${state.contextualScore}/100 · Vitória: ${state.winChance}% · ${state.probability.samples} cartas desconhecidas</div>`;
            return h;
        }
        toggleMinimized() {
            this.minimized = !this.minimized;
            this.get(Config.ids.panel).classList.toggle("minimizado", this.minimized);
            this.get(Config.ids.minimize).textContent = this.minimized ? "+" : "–";
        }
        hideWithRestoreButton() {
            this.wrapper.style.display = "none";
            const b = document.createElement("button");
            b.type = "button";
            b.className = "truco-restore-btn";
            b.textContent = "🃏";
            b.title = "Reabrir Truco QA";
            b.onclick = () => { this.wrapper.style.display = "block"; b.remove(); };
            document.body.appendChild(b);
        }
        enableDrag() {
            let d = false, ox = 0, oy = 0;
            const h = this.get(Config.ids.header);
            h.onmousedown = e => {
                if (e.target.tagName === "BUTTON") return;
                d = true; ox = e.clientX - this.wrapper.offsetLeft; oy = e.clientY - this.wrapper.offsetTop;
            };
            document.addEventListener("mousemove", e => {
                if (!d) return;
                this.wrapper.style.left = `${Utils.clamp(e.clientX - ox, 0, innerWidth - this.wrapper.offsetWidth)}px`;
                this.wrapper.style.top = `${Utils.clamp(e.clientY - oy, 0, innerHeight - this.wrapper.offsetHeight)}px`;
            });
            document.addEventListener("mouseup", () => { d = false; });
        }
        injectStyles() {
            // Estilos com !important + seletores com ID para vencer o CSS da página
            // (o site frequentemente reseta button/input/label, então blindamos tudo aqui).
            GM_addStyle(`
#truco-panel-wrapper *{all:revert!important;box-sizing:border-box!important;font-family:Inter,"Segoe UI",Roboto,Arial,sans-serif!important;text-align:left!important;line-height:1.35!important;}
#truco-panel-wrapper{position:fixed!important;top:12px;left:12px;z-index:2147483647!important;margin:0!important;padding:0!important;}
#truco-panel-wrapper #${Config.ids.panel}{
  display:flex!important;flex-direction:column!important;
  width:230px;min-width:210px!important;min-height:150px!important;max-width:75vw!important;max-height:85vh!important;
  resize:both!important;overflow:hidden!important;
  background:#12172a!important;color:#f2f5fb!important;
  border:1px solid rgba(255,209,102,.5)!important;border-radius:12px!important;
  box-shadow:0 14px 34px rgba(0,0,0,.55)!important;
}
#truco-panel-wrapper #${Config.ids.panel}.minimizado{resize:none!important;min-height:0!important;height:auto!important;}
#truco-panel-wrapper #${Config.ids.panel}.minimizado #${Config.ids.content}{display:none!important;}
#truco-panel-wrapper #${Config.ids.header}{
  flex:0 0 auto!important;display:flex!important;align-items:center!important;gap:6px!important;
  padding:7px 8px!important;cursor:move!important;user-select:none!important;
  background:linear-gradient(90deg,rgba(255,209,102,.16),rgba(67,209,93,.06))!important;
  border-bottom:1px solid rgba(255,209,102,.3)!important;border-radius:12px 12px 0 0!important;
}
#truco-panel-wrapper .truco-drag-dots{color:rgba(255,255,255,.35)!important;font-size:11px!important;flex:0 0 auto!important;}
#truco-panel-wrapper #${Config.ids.header} h3{flex:1 1 auto!important;margin:0!important;padding:0!important;color:#ffd166!important;font-size:11px!important;font-weight:700!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;}
#truco-panel-wrapper .truco-header-actions{flex:0 0 auto!important;display:flex!important;gap:4px!important;}
#truco-panel-wrapper .truco-btn-header{
  all:unset!important;box-sizing:border-box!important;
  width:18px!important;height:18px!important;display:flex!important;align-items:center!important;justify-content:center!important;
  background:rgba(255,255,255,.08)!important;border:1px solid rgba(255,255,255,.18)!important;border-radius:5px!important;
  color:#f2f5fb!important;font-size:11px!important;line-height:1!important;cursor:pointer!important;
}
#truco-panel-wrapper .truco-btn-header:hover{background:rgba(255,255,255,.2)!important;}
#truco-panel-wrapper #${Config.ids.content}{flex:1 1 auto!important;min-height:0!important;overflow-y:auto!important;padding:8px!important;}
#truco-panel-wrapper .truco-sugestao{
  all:unset!important;box-sizing:border-box!important;display:flex!important;flex-direction:column!important;align-items:center!important;
  width:100%!important;padding:8px 6px!important;margin:0 0 7px 0!important;border-radius:8px!important;cursor:pointer!important;
  background:rgba(255,255,255,.06)!important;border:1px solid rgba(255,255,255,.1)!important;text-align:center!important;
}
#truco-panel-wrapper .truco-sugestao-label{font-size:15px!important;font-weight:800!important;color:#c7ccda!important;}
#truco-panel-wrapper .truco-sugestao-sub{font-size:8.5px!important;color:rgba(255,255,255,.55)!important;margin-top:1px!important;}
#truco-panel-wrapper .truco-sugestao.TRUCAR .truco-sugestao-label,#truco-panel-wrapper .truco-sugestao.ACEITAR .truco-sugestao-label{color:#ffd166!important;}
#truco-panel-wrapper .truco-sugestao.TRUCAR,#truco-panel-wrapper .truco-sugestao.ACEITAR{border-color:rgba(255,209,102,.55)!important;background:rgba(255,209,102,.1)!important;}
#truco-panel-wrapper .truco-sugestao.JOGAR .truco-sugestao-label{color:#4ade80!important;}
#truco-panel-wrapper .truco-sugestao.JOGAR{border-color:rgba(74,222,128,.5)!important;background:rgba(74,222,128,.08)!important;}
#truco-panel-wrapper .truco-sugestao.CORRER .truco-sugestao-label{color:#ff6b6b!important;}
#truco-panel-wrapper .truco-sugestao.CORRER{border-color:rgba(255,107,107,.5)!important;background:rgba(255,107,107,.08)!important;}
#truco-panel-wrapper .truco-info{background:rgba(255,255,255,.04)!important;border:1px solid rgba(255,255,255,.08)!important;border-radius:8px!important;padding:7px 8px!important;margin:0 0 7px 0!important;font-size:9.5px!important;color:#dfe3ee!important;}
#truco-panel-wrapper .truco-section-title{font-size:8.5px!important;font-weight:700!important;text-transform:uppercase!important;letter-spacing:.4px!important;color:rgba(255,255,255,.45)!important;margin:6px 0 3px 0!important;}
#truco-panel-wrapper .truco-section-title:first-child{margin-top:0!important;}
#truco-panel-wrapper .truco-alert{background:rgba(255,107,107,.14)!important;border:1px solid rgba(255,107,107,.4)!important;color:#ff9d9d!important;border-radius:6px!important;padding:4px 6px!important;font-size:9.5px!important;font-weight:700!important;margin-bottom:5px!important;}
#truco-panel-wrapper .truco-cartas-row{display:flex!important;flex-wrap:wrap!important;gap:3px!important;}
#truco-panel-wrapper .truco-carta{
  all:unset!important;box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;
  min-width:22px!important;padding:2px 5px!important;border-radius:5px!important;font-size:10px!important;font-weight:700!important;
  background:rgba(255,255,255,.08)!important;border:1px solid rgba(255,255,255,.14)!important;color:#f2f5fb!important;
}
#truco-panel-wrapper .truco-preta{color:#f2f5fb!important;}
#truco-panel-wrapper .truco-vermelha{color:#ff6b6b!important;}
#truco-panel-wrapper .truco-manilha{background:rgba(255,209,102,.22)!important;border-color:rgba(255,209,102,.75)!important;color:#ffd166!important;}
#truco-panel-wrapper .truco-mesa{background:rgba(100,149,237,.18)!important;border-color:rgba(100,149,237,.4)!important;color:#8fb4ff!important;}
#truco-panel-wrapper .truco-parceiro{border-style:dashed!important;border-color:rgba(255,209,102,.7)!important;}
#truco-panel-wrapper .truco-note{font-size:8.5px!important;color:rgba(255,255,255,.55)!important;margin-top:4px!important;}
#truco-panel-wrapper .truco-botoes{display:grid!important;grid-template-columns:1fr 1fr!important;gap:5px!important;margin:0 0 7px 0!important;}
#truco-panel-wrapper .truco-botoes-zerar{grid-template-columns:1fr!important;}
#truco-panel-wrapper .truco-btn{
  all:unset!important;box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:center!important;gap:4px!important;
  min-height:26px!important;padding:5px 4px!important;border-radius:7px!important;cursor:pointer!important;
  background:rgba(255,255,255,.06)!important;border:1px solid rgba(255,255,255,.16)!important;
  color:#f2f5fb!important;font-size:9.5px!important;font-weight:700!important;white-space:nowrap!important;
}
#truco-panel-wrapper .truco-btn-ic{font-size:10px!important;line-height:1!important;}
#truco-panel-wrapper .truco-btn:hover{filter:brightness(1.25)!important;}
#truco-panel-wrapper .truco-btn:disabled{cursor:not-allowed!important;opacity:.38!important;filter:none!important;}
#truco-panel-wrapper .truco-btn-accept{border-color:rgba(74,222,128,.55)!important;color:#7cf0a0!important;}
#truco-panel-wrapper .truco-btn-run{border-color:rgba(255,209,102,.55)!important;color:#ffd166!important;}
#truco-panel-wrapper .truco-btn-ok{border-color:rgba(96,165,250,.55)!important;color:#93c5fd!important;}
#truco-panel-wrapper .truco-btn-danger{border-color:rgba(255,107,107,.55)!important;color:#ff9d9d!important;}
#truco-panel-wrapper .truco-btn-reset{border-color:rgba(255,209,102,.55)!important;color:#ffd166!important;}
#truco-panel-wrapper .truco-toggles{display:flex!important;flex-direction:column!important;gap:4px!important;margin:0 0 7px 0!important;}
#truco-panel-wrapper .truco-switch-label{all:unset!important;box-sizing:border-box!important;display:flex!important;align-items:center!important;gap:6px!important;cursor:pointer!important;font-size:9.5px!important;color:#dfe3ee!important;}
#truco-panel-wrapper .truco-switch-label input{position:absolute!important;opacity:0!important;width:1px!important;height:1px!important;}
#truco-panel-wrapper .truco-switch{
  all:unset!important;box-sizing:border-box!important;position:relative!important;flex:0 0 auto!important;
  width:26px!important;height:14px!important;border-radius:999px!important;background:rgba(255,255,255,.18)!important;
  border:1px solid rgba(255,255,255,.2)!important;transition:background .15s!important;
}
#truco-panel-wrapper .truco-switch::after{content:""!important;position:absolute!important;top:1px!important;left:1px!important;width:10px!important;height:10px!important;border-radius:50%!important;background:#f2f5fb!important;transition:transform .15s!important;}
#truco-panel-wrapper .truco-switch-label input:checked + .truco-switch{background:#4ade80!important;border-color:#4ade80!important;}
#truco-panel-wrapper .truco-switch-label input:checked + .truco-switch::after{transform:translateX(12px)!important;}
#truco-panel-wrapper .truco-status{background:rgba(255,255,255,.04)!important;border:1px solid rgba(255,255,255,.08)!important;border-radius:8px!important;padding:6px 7px!important;display:flex!important;flex-wrap:wrap!important;gap:3px!important;}
#truco-panel-wrapper .truco-chip{background:rgba(255,255,255,.08)!important;border:1px solid rgba(255,255,255,.12)!important;border-radius:999px!important;padding:2px 6px!important;font-size:8px!important;color:#dfe3ee!important;}
#truco-panel-wrapper .truco-chip-warn{background:rgba(255,107,107,.16)!important;border-color:rgba(255,107,107,.45)!important;color:#ff9d9d!important;font-weight:700!important;}
#truco-panel-wrapper .truco-status-reason{flex:1 1 100%!important;font-size:8.5px!important;color:rgba(255,255,255,.6)!important;margin-top:3px!important;}
.truco-restore-btn{all:unset!important;box-sizing:border-box!important;position:fixed!important;bottom:20px!important;left:20px!important;z-index:2147483647!important;width:42px!important;height:42px!important;display:flex!important;align-items:center!important;justify-content:center!important;border-radius:50%!important;background:#12172a!important;border:2px solid #ffd166!important;color:#ffd166!important;font-size:18px!important;cursor:pointer!important;box-shadow:0 8px 20px rgba(0,0,0,.5)!important;}
            `);
        }
    }

    // =====================
    // AUTO PLAYER
    // =====================
    class AutoPlayer {
        constructor(actions) {
            this.actions = actions;
            this.enabled = false;
            this.lastPlayAt = 0;
            this.lastActionAt = 0;
            this.pendingTimer = null;
            this.lastActionSignature = null;
            this.lastCommandKey = null;
            this.lastCommandAt = 0;
            this.lastTurnWaitSignature = null;
            this.readingPending = false;
            this.readingStuckSince = 0;
        }
        buildSignature(state, decision) {
            return [
                state.cards.map(c => GameRules.cardId(c)).sort().join(","),
                state.tableCards.map(c => `${GameRules.cardId(c)}@${c.playerPosition ?? "?"}`).join(","),
                decision.suggestion,
                state.handScore,
                state.contextualScore,
                state.winChance,
                state.cardsThatBeatTable,
                state.cardsThatTieTable,
                state.rodadasCompletas,
                state.rodadasNossa,
                state.rodadasEles,
                state.rodadasEmpatadas,
                state.placar.nos,
                state.placar.eles,
                TrucoState.getValorPontos(),
                state.partnerOpinion?.action || "-",
                state.partnerOpinion?.value || 0,
            ].join("|");
        }
        setEnabled(v) {
            this.enabled = v;
            if (!v) {
                this.lastActionSignature = null;
                this.lastActionAt = 0;
                this.lastCommandKey = null;
                this.lastCommandAt = 0;
                this.lastTurnWaitSignature = null;
                this.readingPending = false;
                this.readingStuckSince = 0;
            }
            if (v) {
                this.lastPlayAt = 0;
                this.lastActionAt = 0;
            }
            if (!v && this.pendingTimer) {
                clearTimeout(this.pendingTimer);
                this.pendingTimer = null;
            }
        }
        tick(state, decision) {
            this.readingPending = decision.suggestion === "AGUARDAR"
                && /Lendo cartas/i.test(decision.reason || "");
            if (this.enabled && this.readingPending && Utils.isMyTurn()) {
                if (!this.readingStuckSince) this.readingStuckSince = Date.now();
                const readingAge = Date.now() - this.readingStuckSince;
                if (readingAge >= 8000) {
                    this.actions.reader.cache.invalidate();
                    this.readingStuckSince = Date.now();
                    Logger.warn("Watchdog: leitura presa por mais de 8s; cache invalidado sem resetar a rodada.");
                }
            } else if (!this.readingPending) {
                this.readingStuckSince = 0;
            }
            const popupDecision = [
                "ACEITAR_TRUCO", "CORRER_TRUCO", "AUMENTAR_TRUCO",
                "JOGAR_MAO10", "CORRER_MAO10"
            ].includes(decision.suggestion);
            if (!this.enabled || this.pendingTimer
                || (!state.totalCards && !popupDecision)
                || decision.suggestion === "AGUARDAR") return;
            const now = Date.now();
            if (!popupDecision && now - this.lastPlayAt <= Config.timings.autoPlayCooldownMs) return;
            const signature = this.buildSignature(state, decision);
            if (signature === this.lastActionSignature) {
                const actionAge = now - this.lastActionAt;
                if (actionAge < Config.timings.actionRetryMs) return;
                Logger.warn(`Estado sem confirmação há ${actionAge} ms; permitindo nova tentativa.`);
            }
            // O popup de resposta tem tempo próprio e fica fora da mesa.
            const respondendoTruco = decision.suggestion === "ACEITAR_TRUCO"
                || decision.suggestion === "CORRER_TRUCO"
                || decision.suggestion === "AUMENTAR_TRUCO";
            const delay = respondendoTruco
                ? 350 + Math.random() * 500
                : 350 + Math.random() * 350;
            this.pendingTimer = setTimeout(() => {
                this.pendingTimer = null;
                detectarTrucoRecebido();
                const cs = GameState.fromReader(this.actions.reader);
                if (!cs.totalCards && !Utils.isTrucoPopupVisible()) return;
                const pedidoDiretoParaMim = cs.isTrucoPending
                    && cs.trucoQuemPediu === "eles"
                    && !TrucoState.paraParceiro;
                const tempoEsperandoOpiniao = Date.now() - (TrucoState.recebidoEm || Date.now());
                const tempoCritico = TimeBarReader.isCritical();
                if (pedidoDiretoParaMim && !cs.partnerOpinion
                    && tempoEsperandoOpiniao < RuntimeConfig.partnerWaitMs && !tempoCritico) {
                    Logger.info(`Aguardando opinião do parceiro (${Math.round(tempoEsperandoOpiniao)} ms).`);
                    return;
                }
                if (pedidoDiretoParaMim && !cs.partnerOpinion && tempoCritico) {
                    Logger.warn("Cronometro critico; assumindo a decisao sem esperar nova opiniao do parceiro.", {
                        restante: `${TimeBarReader.remainingPercent()}%`,
                    });
                }
                const currentDecision = DecisionEngine.analyze(cs);
                if (currentDecision.suggestion === "AGUARDAR") return;
                const currentSignature = this.buildSignature(cs, currentDecision);

                const respostaDeTruco = currentDecision.suggestion === "ACEITAR_TRUCO"
                    || currentDecision.suggestion === "CORRER_TRUCO"
                    || currentDecision.suggestion === "AUMENTAR_TRUCO"
                    || currentDecision.suggestion === "JOGAR_MAO10"
                    || currentDecision.suggestion === "CORRER_MAO10";
                if (currentSignature === this.lastActionSignature) {
                    const actionAge = Date.now() - this.lastActionAt;
                    if (respostaDeTruco || actionAge < Config.timings.actionRetryMs) return;
                    Logger.warn(`Estado da carta ainda igual há ${actionAge} ms; repetindo a ação nativa.`);
                }
                const isCardAction = !respostaDeTruco;
                const commandKey = isCardAction
                    ? [
                        "CARD",
                        cs.cards.map(card => GameRules.cardId(card)).sort().join(","),
                        cs.tableCards.map(card => `${GameRules.cardId(card)}@${card.playerPosition ?? "?"}`).join(","),
                    ].join("|")
                    : currentDecision.suggestion;
                const commandAge = Date.now() - this.lastCommandAt;
                if (isCardAction && commandKey === this.lastCommandKey && commandAge < 1800) {
                    Logger.warn("Comando de carta duplicado bloqueado durante a confirmacao da mesa.", {
                        commandAge,
                        cartas: cs.cards.map(card => `${card.nome}${card.naipe}`).join(","),
                        mesa: cs.tableCards.map(card => `${card.nome}${card.naipe}`).join(","),
                    });
                    return;
                }
                if (!respostaDeTruco && !Utils.isMyTurn()) {
                    if (this.lastTurnWaitSignature !== currentSignature) {
                        Logger.info("Auto-jogador aguardando a confirmacao de turno:", Utils.turnDebug());
                        this.lastTurnWaitSignature = currentSignature;
                    }
                    return;
                }
                this.lastTurnWaitSignature = null;

                let acted = false;
                let executedAction = currentDecision.suggestion;
                try {
                    if (currentDecision.suggestion === "ACEITAR_TRUCO") acted = this.actions.accept();
                    else if (currentDecision.suggestion === "CORRER_TRUCO") acted = this.actions.run();
                    else if (currentDecision.suggestion === "AUMENTAR_TRUCO") acted = this.actions.truco();
                    else if (currentDecision.suggestion === "JOGAR_MAO10") acted = this.actions.mao10Jogar();
                    else if (currentDecision.suggestion === "CORRER_MAO10") acted = this.actions.mao10Correr();
                    else if (currentDecision.suggestion === "PEDIR_TRUCO") {
                        acted = this.actions.truco();
                        if (!acted) {
                            acted = this.actions.playBest();
                            executedAction = "JOGAR_FALLBACK";
                        }
                    } else {
                        acted = this.actions.playBest();
                        executedAction = "JOGAR";
                    }
                } catch (error) {
                    const details = {
                        decisao: currentDecision.suggestion,
                        cartaEscolhida: currentDecision.label,
                        message: error?.message || error,
                        stack: error?.stack,
                    };
                    ErrorSnapshot.capture("decisao automatica", error, details);
                    acted = false;
                }

                if (acted) {
                    this.lastPlayAt = Date.now();
                    this.lastActionAt = this.lastPlayAt;
                    this.lastActionSignature = currentSignature;
                    this.lastCommandKey = commandKey;
                    this.lastCommandAt = this.lastPlayAt;
                    Logger.info("Auto-jogada executada:", executedAction);
                } else {
                    Logger.warn("Auto-jogador nao conseguiu executar:", currentDecision.suggestion);
                }
            }, delay);
        }
    }

    // =====================
    // BOOTSTRAP
    // =====================
    class Bootstrap {
        constructor() {
            this.cache = new QueryCache(document);
            this.reader = new DOMReader(this.cache);
            this.actions = new Actions(this.reader);
            this.ui = new UI(this.actions);
            this.autoPlayer = new AutoPlayer(this.actions);
            this.autoAnalyze = false;
            this.debounceTimer = null;
            this.observerPending = false;
            this.eventsBound = false;
            this.intervalStarted = false;
            this.lastContextSignature = null;
        }
        run() {
            OpponentModel.init();
            DatasetCollector.init();
            SocketAdapter.install();
            NativeCallTracer.install();
            const publicApiTargets = [window, PageWindow].filter((target, index, all) =>
                target && all.indexOf(target) === index
            );
            publicApiTargets.forEach(target => {
                target.TrucoQAExportDataset = () => DatasetCollector.exportJSON();
                target.TrucoQAAnalyzeDataset = () => DatasetCollector.analyze();
                target.TrucoQAClearDataset = () => DatasetCollector.clear();
            });
            // O painel fica disponivel no menu para configuracao. A leitura da
            // partida e a automacao continuam aguardando uma mesa valida.
            this.ui.mount();
            this.bindUiEvents();
            this.startInterval();
            this.whenTableReady(() => this.start());
        }
        dismissInactivePopup() {
            const popup = Utils.$(".popupContainer.popupAlert");
            if (!popup || (!Utils.isVisible(popup) && popup.style.display !== "block")) return false;
            const ok = Utils.$all("button", popup).find(button => {
                const text = String(button.textContent || "").trim();
                return /^ok$/i.test(text) && Utils.isVisible(button);
            });
            if (!ok) return false;
            try {
                ok.click();
                Logger.warn("Popup de inatividade fechado automaticamente.");
                return true;
            } catch (error) {
                ErrorSnapshot.capture("fechamento do popup de inatividade", error);
                return false;
            }
        }
        startInterval() {
            if (this.intervalStarted) return;
            this.intervalStarted = true;
            setInterval(() => this.dismissInactivePopup(), 250);
            setInterval(() => { if (this.autoAnalyze || this.autoPlayer.enabled) this.update(); }, Config.timings.autoAnalyzeIntervalMs);
            // "Sua vez" fica visivel por pouco tempo. Este polling curto so
            // roda com auto-jogada ligada e impede perder a primeira rodada.
            setInterval(() => {
                if (this.autoPlayer.enabled && (Utils.isMyTurn() || this.autoPlayer.readingPending)) this.update();
            }, 250);
            // Pedidos de truco exigem polling curto; nao esperar o intervalo
            // normal de analise enquanto o cronometro esta correndo.
            setInterval(() => {
                if ((this.autoAnalyze || this.autoPlayer.enabled) && Utils.isTrucoPopupVisible()) this.update();
            }, 250);
        }
        getActiveTable() {
            return Utils.$all(Config.selectors.mesa).find(mesa => {
                if (!Utils.isVisible(mesa)) return false;
                const jogadores = Utils.$all(":scope > .jogador", mesa)
                    .filter(jogador => Utils.isVisible(jogador));
                return jogadores.length >= 4;
            }) || null;
        }
        whenTableReady(cb) {
            const mesa = this.getActiveTable();
            if (mesa) { cb(); return; }
            setTimeout(() => this.whenTableReady(cb), Config.timings.bootRetryMs);
        }
        start() {
            Logger.info("Mesa encontrada.");
            NativeCallTracer.install();
            window.TrucoQADebug = () => {
                this.cache.invalidate();
                const state = GameState.fromReader(this.reader);
                const data = { placar: state.placar, tentoDOM: state.placar.tentoAtual, truco: { valor: TrucoState.getValorPontos(), texto: TrucoState.getValorText(), quemPediu: TrucoState.quemPediu }, jogadores: state.placar.times?.jogadores || [] };
                console.table(data.jogadores);
                console.log("[QA Truco] Diagnóstico:", data);
                return data;
            };
            window.TrucoQASmokeTest = () => {
                const optional = new Set([
                    "turnedCard", "popupMao10", "popupTruco", "popupTrucoAceitar",
                    "popupTrucoCorrer", "popupTrucoAumentar", "parceiroOpiniao",
                ]);
                const result = Object.entries(Config.selectors).map(([name, selector]) => {
                    const count = Utils.$all(selector).length;
                    return { name, selector, count, required: !optional.has(name), ok: count > 0 };
                });
                const requiredFailures = result.filter(item => item.required && !item.ok);
                console.table(result);
                Logger.info("Smoke test dos seletores:", requiredFailures.length ? "FALHOU" : "OK", requiredFailures);
                return { ok: requiredFailures.length === 0, result, requiredFailures };
            };
            window.TrucoQASocketDebug = () => {
                const data = {
                    comandosNativos: NativeCallTracer.calls.slice(-20),
                    webSocketEnviado: SocketAdapter.data.sent.slice(-20),
                };
                console.log("[QA Truco] Ultimos comandos:", data);
                return data;
            };
            window.TrucoQAExportDataset = () => DatasetCollector.exportJSON();
            window.TrucoQAAnalyzeDataset = () => DatasetCollector.analyze();
            window.TrucoQAClearDataset = () => DatasetCollector.clear();

            // 🆕 RAIO-X: despeja a estrutura REAL do DOM (sem nenhuma suposição do
            // script) pra calibrar a detecção de cor/time com dados de verdade.
            // Rode `TrucoQARaioX()` no console durante uma partida e cole o resultado.
            window.TrucoQARaioX = () => {
                const linhas = [];
                Utils.$all('[id^="jogador"]').forEach(jogadorEl => {
                    const foto = jogadorEl.querySelector('.foto');
                    const nomeEl = jogadorEl.querySelector('.nome');
                    linhas.push({
                        id: jogadorEl.id,
                        classesJogador: jogadorEl.className,
                        classesFoto: foto ? foto.className : '(sem .foto)',
                        corComputada: foto ? getComputedStyle(foto).backgroundColor : '-',
                        avatarUrl: foto ? (foto.style.backgroundImage || '-') : '-',
                        nome: nomeEl ? nomeEl.textContent.trim() : '-',
                        dentroDoPopupTruco: foto ? Utils.isInsideTrucoPopup(foto) : false,
                    });
                });
                const pontosEl = Utils.$('.pontos');
                const time1SpanEl = Utils.$(Config.selectors.time1Span);
                const time2SpanEl = Utils.$(Config.selectors.time2Span);
                const resultado = {
                    jogadores: linhas,
                    pontosHTML: pontosEl ? pontosEl.outerHTML : '(não encontrado)',
                    time1SpanClasses: time1SpanEl ? time1SpanEl.className : '(não encontrado)',
                    time1SpanCor: time1SpanEl ? getComputedStyle(time1SpanEl).backgroundColor : '-',
                    time2SpanClasses: time2SpanEl ? time2SpanEl.className : '(não encontrado)',
                    time2SpanCor: time2SpanEl ? getComputedStyle(time2SpanEl).backgroundColor : '-',
                    corCacheadaAtual: ScoreReader._nossaCor,
                };
                console.table(linhas);
                console.log("[QA Truco] RAIO-X completo:", resultado);
                return resultado;
            };

            // 🆕 Força o assistente a esquecer a cor detectada e tentar de novo no
            // próximo update (útil pra testar sem precisar recarregar a página).
            window.TrucoQAResetCor = () => {
                ScoreReader._nossaCor = null;
                this.cache.invalidate();
                Logger.info("Cor do time zerada. Próxima análise vai redetectar.");
                return this.reader.getState().placar;
            };
            this.ui.mount();
            this.observeTable();
            Logger.info(`v${Config.version} pronto.`);
        }
        bindUiEvents() {
            if (this.eventsBound) return;
            this.eventsBound = true;
            this.ui.get(Config.ids.suggestion).onclick = () => this.updateNow();
            this.ui.get(Config.ids.autoAnalyze).onchange = e => { this.autoAnalyze = e.target.checked; if (this.autoAnalyze) this.update(); };
            this.ui.get(Config.ids.autoPlay).onchange = e => { this.autoPlayer.setEnabled(e.target.checked); if (e.target.checked) this.update(); };
            document.addEventListener("visibilitychange", () => {
                if (!document.hidden && (this.autoAnalyze || this.autoPlayer.enabled)) this.updateNow();
            });
            document.addEventListener("truco:reset-panel", () => {
                this.autoAnalyze = false;
                this.autoPlayer.setEnabled(false);
                clearTimeout(this.debounceTimer);
                this.debounceTimer = null;
                this.observerPending = false;
            });
        }
        update() { if (this.debounceTimer) return; this.debounceTimer = setTimeout(() => this.updateNow(), Config.timings.debounceMs); }
        updateNow() {
            try {
                clearTimeout(this.debounceTimer); this.debounceTimer = null;
                this.cache.invalidate();
                NativeCallTracer.install();
                detectarTrucoRecebido();
                const state = GameState.fromReader(this.reader);
                const decision = DecisionEngine.analyze(state);
                const contextSignature = [
                    state.cards.map(c => GameRules.cardId(c)).join(","),
                    state.tableCards.map(c => `${GameRules.cardId(c)}@${c.playerPosition ?? "?"}`).join(","),
                    state.rodadaAtual,
                    state.contextualScore,
                    decision.suggestion,
                    state.partnerOpinion?.action || "-",
                    state.partnerOpinion?.value || 0
                ].join("|");
                DatasetCollector.record(state, decision, contextSignature);
                if (contextSignature !== this.lastContextSignature) {
                    Logger.info("Reavaliacao contextual:", {
                        rodada: state.rodadaAtual,
                        posicaoNaVaza: state.minhaPosicaoNaRodada,
                        parceiroForcaVista: state.partnerStrengthEstimate,
                        cartasNoTopoEfetivo: state.effectiveStrengths
                            .filter(item => item.absoluteTop)
                            .map(item => `${item.card.nome}${item.card.naipe}`),
                        mesa: state.tableCards.map(c => `${c.nome}${c.naipe}`),
                        nossaDuplaVence: state.tableWinnerIsOurTeam,
                        coberturas: state.cardsThatBeatTable,
                        rodadas: `${state.rodadasNossa}x${state.rodadasEles}`,
                        empates: state.rodadasEmpatadas,
                        score: state.contextualScore,
                        opiniaoParceiro: state.partnerOpinion
                            ? `${state.partnerOpinion.action}${state.partnerOpinion.value ? ` ${state.partnerOpinion.value}` : ""}`
                            : "-",
                        decisao: decision.label,
                    });
                    this.lastContextSignature = contextSignature;
                }
                this.ui.render(state, decision);
                this.autoPlayer.tick(state, decision);
            } catch(e) {
                ErrorSnapshot.capture("ciclo de atualizacao", e);
                this.debounceTimer = null;
                this.observerPending = false;
            }
        }
        observeTable() {
            const table = this.getActiveTable(); if (!table) return;
            new MutationObserver(() => {
                this.cache.invalidate();
                if ((!this.autoAnalyze && !this.autoPlayer.enabled) || this.observerPending) return;
                this.observerPending = true;
                requestAnimationFrame(() => { this.observerPending = false; this.update(); });
            }).observe(table, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });

            // O popup #popupTrucar/#popupJogo nao pertence a .mesa. Observar o
            // documento garante que a analise comece assim que o pedido aparece.
            new MutationObserver(mutations => {
                if (!this.autoPlayer.enabled && !this.autoAnalyze) return;
                const popupMudou = mutations.some(mutation => {
                    const alvo = mutation.target?.closest?.("#popupJogo, #popupTrucar");
                    const novoPopup = [...(mutation.addedNodes || [])].some(node =>
                        node.nodeType === 1 && node.matches?.("#popupJogo, #popupTrucar")
                    );
                    return Boolean(alvo || novoPopup);
                });
                const jogoMudou = mutations.some(mutation => {
                    const alvo = mutation.target?.closest?.("#telaJogo .jogo, #mensagem, #acoesCartaVirada, #trucoAumentar, .rodada");
                    const novoEstado = [...(mutation.addedNodes || [])].some(node =>
                        node.nodeType === 1 && (node.matches?.(".cartaMesa, .carta") || node.querySelector?.(".cartaMesa"))
                    );
                    return Boolean(alvo || novoEstado);
                });
                if (!popupMudou && !jogoMudou) return;
                this.cache.invalidate();
                if (popupMudou && Utils.isTrucoPopupVisible()) this.updateNow();
                else this.update();
            }).observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["class", "style"]
            });
        }
    }

    window[APP_KEY] = new Bootstrap();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => window[APP_KEY].run(), { once: true });
    else window[APP_KEY].run();
})();
