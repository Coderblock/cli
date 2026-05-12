---
name: using-agent-teams
description: Use when the user asks to create, spawn, coordinate, or use an agent team / team of agents / multi-agent setup / parallel teammates / squad of Claude instances. Triggers on phrases like "agent team", "team di agenti", "crea un team", "spawna teammates", "coordina più agenti in parallelo".
---

# Using Agent Teams (Reference Guide)

Riferimento operativo per orchestrare team di sessioni Claude Code. Ottimizzato per essere scansionato velocemente prima di ogni esecuzione.

## Quando usare un Agent Team (vs alternative)

| Scenario | Strumento giusto |
|----------|------------------|
| Ricerca/review multi-angolo (es. PR review da prospettive diverse) | **Agent Team** |
| Moduli/feature nuove con pezzi indipendenti | **Agent Team** |
| Debugging con ipotesi concorrenti che si sfidano | **Agent Team** |
| Cambiamenti cross-layer (frontend + backend + test) | **Agent Team** |
| Una sola query focalizzata, mi serve solo il risultato | **Subagent** (Agent tool) |
| Task sequenziale, edit sullo stesso file, molte dipendenze | **Sessione singola** |
| Ricerca esplorativa che non richiede comunicazione tra worker | **Subagent** |

**Regola euristica:** se i worker devono *parlarsi* (sfidarsi, sintetizzare, coordinare un task list condiviso) → Agent Team. Altrimenti → subagent.

## Pre-requisiti

1. Claude Code v2.1.32+
2. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `settings.json` o env
3. (Opzionale) tmux o iTerm2 + `it2` per split-pane

## Template di spawn (copia-incolla mentale)

Quando l'utente chiede un team, struttura sempre la richiesta interna in questi punti:

```
1. OBIETTIVO del team (cosa stiamo cercando di ottenere)
2. NUMERO di teammates (default 3-5, mai oltre se non c'è motivo)
3. RUOLO esplicito di ciascuno (lente diversa, no overlap)
4. MODELLO per teammate (Sonnet di default, Opus per ragionamento profondo)
5. APPROVAZIONE del piano? (sì per task rischiosi/ampi)
6. CRITERI di approvazione (es. "solo se include test coverage")
7. CONTESTO del task nel prompt di spawn (i teammate NON ereditano la conversazione del lead)
```

### Esempi di prompt ben formati

**Code review parallelo:**
```
Crea un team di 3 teammates per review di [path/PR].
- Reviewer A: security (token, sessioni, validazione input)
- Reviewer B: performance (query N+1, allocazioni, hot path)
- Reviewer C: test coverage (path non coperti, edge case)
Tutti su Sonnet. Sintetizza i findings al termine.
```

**Debugging adversariale:**
```
Bug: [descrizione]. Spawna 4 teammates, ognuno con un'ipotesi diversa.
Devono sfidare attivamente le ipotesi degli altri (debate scientifico).
Aggiorna findings.md con il consensus finale.
```

**Feature cross-layer:**
```
Implementa [feature]. Team di 3:
- Backend (owner: src/api/, src/services/)
- Frontend (owner: src/components/, src/pages/)
- Test (owner: tests/, e2e/)
File ownership rigido per evitare conflitti.
Richiedi plan approval prima di scrivere codice.
```

## Best Practices (regole rigide)

1. **3-5 teammates**, mai di più senza motivo concreto. 5-6 task per teammate.
2. **File ownership disgiunto.** Due teammate sullo stesso file = overwrite.
3. **Prompt di spawn auto-contenuto.** Il teammate carica `CLAUDE.md` + MCP + skills, ma NON la storia del lead. Includi: file rilevanti, vincoli, criteri di output.
4. **Plan approval per task rischiosi.** Sempre per refactor, schema DB, security, deploy.
5. **Dì al lead di aspettare.** Tendenza nota: il lead inizia a implementare invece di delegare. Contromossa: "Wait for your teammates to complete their tasks before proceeding".
6. **Inizia con review/research** se è la prima volta in un progetto. Boundary chiare, no race su file.
7. **Pre-approva permessi comuni** prima dello spawn per ridurre i prompt.
8. **Cleanup sempre via lead**, mai dai teammates. Prima shutdown, poi cleanup.

## Display mode

| Mode | Quando | Note |
|------|--------|------|
| `in-process` (default) | Qualsiasi terminale, setup zero | Shift+Down per ciclare teammates, Ctrl+T per task list, Esc per interrompere |
| `tmux` / split-pane | Già dentro tmux o iTerm2 con `it2` | Ogni teammate in un pannello, click per interagire |

Override sessione singola: `claude --teammate-mode in-process`

## Limitazioni note (aspettative realistiche)

- ❌ `/resume` e `/rewind` NON ripristinano teammates in-process → spawna nuovi se serve
- ❌ Nessun team annidato (i teammates non possono creare team)
- ❌ Un solo team per sessione lead (cleanup prima del prossimo)
- ❌ Permission mode si imposta a livello team al spawn, modificabile per teammate solo dopo
- ⚠️ Task status può rimanere stale → check manuale se sembra bloccato
- ⚠️ Shutdown lento (aspetta tool call corrente)
- ⚠️ Il lead può chiudere prematuramente → "keep going, teammates aren't done"

## Hooks per quality gates (opzionale)

- `TeammateIdle`: blocca l'idle, forza più lavoro (exit 2)
- `TaskCreated`: blocca creazione task non validi (exit 2)
- `TaskCompleted`: blocca chiusura task non verificati (exit 2)

## Costi (token)

Ogni teammate ha context window proprio → costi *lineari nel numero di teammate*. Per task routinari, una sessione singola è più economica. Giustificato quando il parallelismo riduce *materialmente* il tempo o migliora la qualità (es. consensus debate).

## Anti-pattern da evitare

| Anti-pattern | Cosa fare invece |
|--------------|------------------|
| "Spawna 8 teammates per fare X" senza ruoli distinti | Definisci 3-5 lenti **diverse** |
| Prompt di spawn vago ("review the code") | File specifici + criteri + formato output |
| Overlap di file ownership | Tabella ownership esplicita prima dello spawn |
| Lead che fa il lavoro al posto dei teammates | Reminder esplicito: "delega, non implementare" |
| Cleanup con teammates ancora attivi | Shutdown ordinato, poi cleanup |
| Team per task sequenziale | Sessione singola |

## Workflow check-list (prima di proporre un team)

- [ ] Il task beneficia *davvero* di parallelismo? (sì/no, non "forse")
- [ ] I worker possono lavorare senza condividere stato continuamente?
- [ ] Ho 3-5 ruoli distinti con boundary chiare?
- [ ] Il prompt di spawn contiene tutto il contesto necessario (no eredità conversazione)?
- [ ] File ownership è disgiunto?
- [ ] Serve plan approval? Con quali criteri?
- [ ] Ho un piano di sintesi/cleanup?

Se una di queste risposte è "no" o "non lo so" → fermati, chiedi all'utente o usa subagent/sessione singola.

## Iterazione (per migliorare nel tempo)

Questo skill è progettato per evolvere. Dopo ogni uso reale di Agent Teams in questo progetto, registra qui sotto cosa ha funzionato e cosa no:

### Lessons learned (append-only)

<!-- Aggiungi voci tipo:
- [DATA] [PROGETTO] Cosa: ... Funzionato: ... Da migliorare: ...
-->
