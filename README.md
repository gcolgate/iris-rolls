# Iris Rolls

A Foundry VTT module for the D&D 5e system. It takes over sheet rolls, skips the usual configuration dialogs, always rolls two d20s, and puts advantage, targets, hit/miss, and damage application on the chat card.

This first release is for testing (including The Forge). Treat it as alpha.

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

## How it works

- Rolling from a sheet uses that actor as the roller. Selected tokens are the targets.
- If you forgot to select someone, change targets on the chat card.
- If you forgot advantage or disadvantage, change it on the chat card.
- Area-effect spells place a template. Tokens in the template are selected as targets automatically. You can still override that on the card.
- Saves are rolled automatically, including Evasion. Advantage, disadvantage, and some other 5e save rules may still need work.
- Apply results with **Add Damage** or **Add Effects**.
- The card also has a description button and an undo button.

## License

MIT. See [LICENSE](LICENSE).
