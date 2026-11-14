# Swarm mode: training-free take on s³

Status: MVP on `pushkar-codex/agent-voting` (Nov 2026). Implemented by Codex; see `app/server/swarm/`.

## 1. Research findings

### s³: Simple Scaling of Swarms via Cooperative Multi-agent RL
Jha, Faria, Li, Geng, Brahman, Smith, Tsvetkov, Kleiman-Weiner, Jaques (UW + Ai2), arXiv [2611.08615](https://arxiv.org/abs/2611.08615), site <https://scalingswarms.com/>. Code is not released.

- **Swarm = N copies of one model.** No leader, no roles, no turn order. Every agent gets the same prompt (shared policy).
- **Communication is only through two tools:** `message(to, text)` and `read_messages()`. Messages show up as unread-count notifications, and an idle agent is woken by them. Sending is never rewarded directly.
- **Fully asynchronous.** An agent continues as soon as its own tool call returns and never waits on the slowest teammate. Generation is chunked to 1,024 tokens so notifications can land.
- **Shared team reward:** `R = S · (1 − λ·min(1, Σ|τᵢ| / (N·L)))` with λ = 0.25. S is team success (any agent solves it), and the second term is a token-cost penalty.
- **Credit assignment by comparing teams, not agents.** It samples 8 teams per problem and applies a GRPO-style advantage `(R_g − mean R) / std`. Every token from a team gets that team's advantage. Per-agent credit is never estimated.
- **Individual rewards fail.** Sharing only helps others, so it becomes a public-goods game and agents stop sharing. The shared reward removes this.
- **Results** (Qwen3 0.6B/1.7B):
  - Information aggregation: 93% vs 35% (SFT on own successes) vs 13% (individual reward) with 4 agents, and over 25× the strongest baseline with 8 agents.
  - Exploration: messaging cuts repeated search by about 50% and beats matched-budget best-of-N by up to 9.4 points.
- **Their harness prompt** (Appendix F) is reusable as-is. Its rules: same objective, no roles, work alone when useful, share checked evidence, keep verified facts separate from guesses, don't count repeats as verification, don't chatter to stay active.

### Related work (Jaques / Kleiman-Weiner)
| Paper | Takeaway for us | Code |
| --- | --- | --- |
| Jha, Kleiman-Weiner, Jaques, *From Solo to Social Learning: Recursive Social Improvement in LLMs* (2026) [arXiv 2609.38516](https://arxiv.org/abs/2609.38516) | Prompted (training-free) LLM populations that copy peers' skill files are **more efficient but not more effective** than solo learners at equal token cost. This is the honest prior for our MVP. | n/a |
| Jha et al., *Cross-Environment Cooperation Enables Zero-shot Coordination* (ICML 2025 oral) [arXiv 2504.12714](https://arxiv.org/abs/2504.12714) | Training on many environments gives general cooperative norms. | Jax generators |
| Liu, Guertler, … Jaques, *SPIRAL* (ICLR 2026) [arXiv 2506.24119](https://arxiv.org/abs/2506.24119) | Online multi-agent, multi-turn RL for LLMs, with role-conditioned advantage estimation. The closest **open infra** if we ever train. | [spiral-rl/spiral](https://github.com/spiral-rl/spiral) |
| Jaques et al., *Social Influence as Intrinsic Motivation for MARL* (ICML 2019) [arXiv 1810.08647](https://arxiv.org/abs/1810.08647) | Rewards an agent for causally changing teammates' actions. A cheap training-free analogue is crediting posts that teammates later build on. | — |
| Piatti, Jin, Kleiman-Weiner et al., *Cooperate or Collapse (GovSim)* (NeurIPS 2024) [arXiv 2404.16698](https://arxiv.org/abs/2404.16698) | Prompted LLM societies mostly fail to cooperate. Communication and "universalization" reasoning help. | [giorgiopiatti/GovSim](https://github.com/giorgiopiatti/GovSim) |
| Kleiman-Weiner et al., *Evolving general cooperation with a Bayesian theory of mind* (PNAS 2025) [doi](https://doi.org/10.1073/pnas.2400993122) | Cooperate in proportion to the inferred probability that partners share your goal. This could feed agent-trust weights. | [maxkw/evolution](https://github.com/maxkw/evolution) |
| Wu, Wang, …, Kleiman-Weiner, *Too Many Cooks* (2021) | Bayesian inference of who is doing which subtask, which avoids duplicated work. Our "claim" posts are the explicit version. | gym-cooking |
| Jha, Huang, Ye, Jaques, Kleiman-Weiner, *Modeling Others' Minds as Code* (ICLR 2026) | Theory of mind via program synthesis of others' behaviour. | — |

## 2. What we implemented (training-free)
| s³ concept | Our MVP |
| --- | --- |
| N copies of one policy, no roles | One **byte-identical shared policy** text (`buildSwarmPolicy`) plus a one-line identity suffix (handle + own post file + teammates), as in s³ where agents know names. Heterogeneous models (Codex, Claude Code), so it is a shared *prompt* policy, not shared weights. |
| `message` / `read_messages` | **Blackboard**: each agent appends JSON lines (`claim`, `note`, `contribution`, `question`, `done`) to `posts/<id>.jsonl`. The server polls them (~1s), validates, stamps them, and is the only writer of `blackboard.jsonl`. Agents read it whenever they choose. Stray post files are ingested as `unknown:<name>`. |
| Shared memory | `swarms/<id>/shared/` is the joint deliverable dir, and `blackboard.jsonl` is the shared log. |
| Asynchrony, no turns | There are no rounds. When an agent's run exits and budget remains, that agent is relaunched immediately without waiting for the slowest teammate. Concurrency cap ≤ 4, `maxTurns` ≤ 8, and a swarm timeout of 10 min. |
| Team reward | `teamReward = S·(1 − 0.25·min(1, outputChars / (N·60k)))`. Output chars stand in for tokens. S comes from an evaluator: a Codex run writing `eval/evaluation.json`, with a heuristic fallback. **Every participant gets the same reward.** |
| Team-level credit / learning | No gradients. `swarm-stats.json` keeps the mean team reward per agent, and **UCB1** picks participants when none are specified (a bandit stands in for RL). Evaluator lessons go to `swarm-lessons.jsonl`, and the last 5 are injected into future policies (in-context adaptation of the shared policy). Per-agent contribution shares are recorded for diagnostics only. |
| Best-of-N baseline | `mode: "best-of-n"` runs each agent solo in `solo/<id>/` with no blackboard. Each run is scored and the best is kept. Every run is logged to `swarm-runs.jsonl` for swarm-vs-BoN comparison. |
| Voice | The spoken-intent schema gained `collaboration: solo|swarm`, plus a keyword fallback (swarm / as a team / together / all agents / everyone). "Hey Marbles, have all agents work together on X" starts a swarm. |
| Canvas | A violet swarm node is linked to participating agents. Recent blackboard posts are children and shared artifacts are deliverable nodes. The detail panel shows reward, success, token proxy, runs, lesson and blackboard. |

API: `POST /api/swarm/tasks {goal, agents?, mode?, maxTurns?, concurrency?, size?}`, `GET /api/swarm/tasks[/:id]`, `POST /api/swarm/tasks/:id/cancel`, `GET /api/swarm/stats`.

### First live results (tiny task, Codex + Claude Code)
- **Swarm:** the agents claimed, detected a claim collision, and one deferred and reviewed while the other wrote. Success 1.0, reward 0.985, about 7.1k chars.
- **Best-of-2:** success 1.0, reward 0.994, about 3.0k chars.

On a trivial task the swarm only adds coordination cost. That matches *From Solo to Social Learning*. The swarm should be judged on tasks with **private information or a large search space** (multi-file codebase audits, parallel bug hunts, research across many sources), where s³ shows the gains.

## 3. What needs real RL (out of scope here)
- Training a shared policy with the team-relative advantage (GRPO over teams) needs open weights, e.g. Qwen3 with SPIRAL/OpenRLHF-style async infra. Closed CLIs (Codex, Claude Code) cannot be fine-tuned this way.
- Learned communication timing (when to share or read), chunked-generation interrupts, and off-policy correction (IcePop) are not possible with closed agents. We approximate them with prompt rules and process restarts.
- SFT warm-start on successful swarm traces. We do log traces (`swarm.json`, blackboard), which could become a dataset.

## 4. Next steps
1. **Benchmark set:** 10–20 tasks of the aggregation type (each agent is given a different private file or source) and the exploration type (bug hunt in a repo). Run swarm vs best-of-N at **matched budget** (`maxTurns = N` vs N solo runs) and report from `swarm-runs.jsonl`.
2. **Notifications:** wake idle agents when a teammate posts. Today an agent only rereads the blackboard during its own run or on relaunch.
3. **Team-relative credit:** run K swarms per goal and compute an s³-style advantage per team. Feed it into the bandit and lesson selection, keeping only lessons from above-mean teams.
4. **Matched evaluator:** make the evaluator deterministic where possible (tests, checks), and separate evaluator spend from team spend.
5. Add Cursor via the `cursor-agent` CLI and OpenClaw once they have non-interactive launchers.
6. Influence-style credit, after Jaques 2019: count posts that teammates cite or build on.
7. If we want true MARL, prototype s³ on Qwen3-1.7B with SPIRAL's infra on the information-aggregation task.
