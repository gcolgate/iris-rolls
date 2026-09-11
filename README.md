# Iris Rolls

A Foundry VTT module for the D&D 5e system. It takes over sheet rolls, skips the usual configuration dialogs, always rolls two d20s, and puts advantage, targets, hit/miss, and damage application on the chat card.

We don't use the target mechanism to pick targets, instead, we use selecting.

This release is for testing (including The Forge). Treat it as alpha. It is slowly getting better though.

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

## What's new in 1.1.3
 

- Attacks wait for a real target. If nothing is selected, or only the roller is selected, a “Please select a target” prompt stays up until you pick someone else. Attacks also skip the roller when another token is selected, so opening a sheet no longer makes Bite or Claw hit yourself.
- Scalable spells (slots and spell points) ask for a cast level before the chat card: name, image, description, and a level dropdown. Cancel aborts the cast.
- Clicking **Total Damage** or **Total Healing** applies the result. A successful apply plays the dice sound.
- d20 faces show the roll plus bonuses. Hover a die for the raw d20, the bonus, and Reliable Talent when it applies.
- Applied amounts and the damage total are larger and red. When the card is wide enough, the total is labeled Total Damage or Total Healing.
- Slot dropdowns keep cream options and dark text so they stay readable (including on The Forge).
- **React → Shield** now applies a real effect until that actor’s next turn, including creatures with flat AC.
- **React** shows for the target’s owner on a GM-authored card, not only for the person who rolled.
- As the GM, with chat visible, changing the selected tokens retargets your most recent unapplied Iris card (not player-character rolls, not concentration, not live AoE templates). Turn this off in **Configure Settings → Iris Rolls → Retarget latest card from selection**.

See the [1.1.3 release notes](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.3). Older notes: [1.1.2](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.2), [1.1.1](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.1), [1.1.0](https://github.com/gcolgate/iris-rolls/releases/tag/1.1.0).

## How it works

- Rolling from a sheet uses that actor as the roller. Selected tokens are the targets. Players can left-click or box-select tokens they do not own to pick those targets. That is select-only: it does not let them move the token, open its sheet, or change HP.
- If an attack has no other token selected, Iris asks you to select a target before it rolls.
- If you forgot to select someone after the card is up, change targets on the chat card. The GM can also retarget their latest unapplied NPC card just by changing the selection while chat is visible.
- Spells that can be upcast ask for a slot or spell-point level before the card posts. You can still change the level on the card afterward.
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

# to do 

Fix prismatic spray
support foundry 13 and 14

 