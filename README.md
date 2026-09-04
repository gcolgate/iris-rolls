# Iris Rolls

A Foundry VTT module for the D&D 5e system. It takes over sheet rolls, skips the usual configuration dialogs, always rolls two d20s, and puts advantage, targets, hit/miss, and damage application on the chat card.

We don't use the target mechanism to pick targets, we use selecting.

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

## What's new in 1.1.1

- Players can left-click or box-select tokens they do not own to pick Iris Rolls targets. That is select-only: it does not let them move the token, open its sheet, or change HP.
- Area templates now keep those unowned tokens selected, so Change Targets still works after a Fireball.

See the [1.1.1 release notes](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.1). Older notes: [1.1.0](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.0).

## How it works

- Rolling from a sheet uses that actor as the roller. Selected tokens are the targets. Players can left-click or box-select tokens they do not own to pick those targets. That is select-only: it does not let them move the token, open its sheet, or change HP.
- If you forgot to select someone, change targets on the chat card.
- If you forgot advantage or disadvantage, change it on the chat card. Each target can have its own roll, bonus, and advantage mode.
- Area-effect spells place a template. Tokens in the template are selected as targets automatically, including tokens a player does not own. You can still override that on the card, or remove/replace the template.
- Saves are rolled automatically, including Evasion. Advantage, disadvantage, and some other 5e save rules may still need work.
- Apply results with **Apply Damage** or **Apply Effect**. **Apply again** lets you apply a second time without undoing the first.
- Hover damage lines, totals, or a target's applied amount to see each die.
- When a target has a matching reaction, **React** appears on that row. The target's owner or the GM can use it.
- **Again** and **Again no resources** sit at the bottom of the card. Area spells ask you to place a new template first.
- Click the used d20 to reroll or replace it.
- The card also has a description button and an undo button. Used slots, points, and feature uses can be refunded from the card.

## License

MIT. See [LICENSE](LICENSE).
