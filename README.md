# Iris Rolls

A Foundry VTT module for the D&D 5e system. It takes over sheet rolls, skips the usual configuration dialogs, always rolls two d20s, and puts advantage, targets, hit/miss, and damage application on the chat card.

This release is for testing (including The Forge). Treat it as alpha.

## Requirements

- Foundry Virtual Tabletop v13
- [D&D 5e](https://foundryvtt.com/packages/dnd5e) 5.0.0 or later (verified on 5.0.4)

Do not enable this together with Midi QOL or Ready Set Roll. Those modules also replace 5e roll cards, and Iris Rolls will warn if they are active.

## Install

**From a Manifest URL** (Foundry Setup or The Forge):

```
https://github.com/gcolgate/iris-rolls/releases/latest/download/module.json
```

**From this repo** (local development): copy or clone the `iris-rolls` folder into `{userData}/Data/modules/iris-rolls`.

## What's new in 1.1.0

- **Again** recasts the same activity with the same roller and targets, and spends slots, spell points, or uses.
- **Again no resources** does the same recast without spending those costs.
- Area spells recast with **Again** place a **new** template and target whoever is inside it. Canceling the template spends nothing.
- Matching **reactions** can be used from the card: Shield, Defensive Duelist, Uncanny Dodge, Deflect Attacks, Warding Flare, Riposte, Absorb Elements, Hellish Rebuke, and Stone's Endurance.
- Hover a damage line, the damage total, or a target's applied amount to see **each die roll**.
- Click the **used d20** to reroll or replace it (Halfling Lucky, Lucky, Portent, Indomitable, Stroke of Luck, Clockwork Amulet, plus DM reroll/set).
- Proficient skill and tool checks apply **Reliable Talent** (9 or lower becomes 10).
- Per-target damage multipliers (0, ¼, ½, 1, 2) and a **Bonus Damage** field on the card.

See the [1.1.0 release notes](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.0) for the short changelog.

## How it works

- Rolling from a sheet uses that actor as the roller. Selected tokens are the targets.
- If you forgot to select someone, change targets on the chat card.
- If you forgot advantage or disadvantage, change it on the chat card. Each target can have its own roll, bonus, and advantage mode.
- Area-effect spells place a template. Tokens in the template are selected as targets automatically. You can still override that on the card, or remove/replace the template.
- Saves are rolled automatically, including Evasion. Advantage, disadvantage, and some other 5e save rules may still need work.
- Apply results with **Apply Damage** or **Apply Effect**. **Apply again** lets you apply a second time without undoing the first.
- Hover damage lines, totals, or a target's applied amount to see each die.
- When a target has a matching reaction, **React** appears on that row. The target's owner or the GM can use it.
- **Again** and **Again no resources** sit at the bottom of the card. Area spells ask you to place a new template first.
- Click the used d20 to reroll or replace it.
- The card also has a description button and an undo button. Used slots, points, and feature uses can be refunded from the card.

## License

MIT. See [LICENSE](LICENSE).
