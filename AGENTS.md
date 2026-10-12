# MagicMinutes for AI agents
MagicMinutes is a D&D player companion (campaign notes, places, NPCs, sessions). This
command-line tool reads and adds to the user's campaigns, no clicking needed.

## How to call it
The program is `magicminutes.exe`, in the folder MagicMinutes is installed to (by default
`%LOCALAPPDATA%\MagicMinutes\`). It comes with the MagicMinutes AI edition; the standard
edition doesn't have it. Use its full path, in quotes:
`"C:\Users\<name>\AppData\Local\MagicMinutes\magicminutes.exe" help`
Below, `magicminutes` stands for that. A call takes a second or two and prints plain
text. Exit code 0 = fine, 1 = you got something wrong (the message says how to fix it),
2 = it broke.

## Commands
    magicminutes campaigns                          list campaigns (* = current)
    magicminutes campaigns add "Name"               new empty campaign
    magicminutes notes list [--limit 20] [--category Quest]
    magicminutes notes search "words" [--limit 20]
    magicminutes notes show <id>                    ids are the first 8 characters
    magicminutes notes add --title "T" --text "Body" [--place P] [--tags a,b] [--category Quest]
    magicminutes notes import <file> [--yes]        text or notes JSON; duplicates skipped
    magicminutes notes export <file> [--search "words"]
    magicminutes export <file>                      whole-campaign JSON backup
    magicminutes import <file> [--replace] [--yes]  merge (default) or replace
    magicminutes run <file>                         several commands, one per line
    Options: --campaign "Name" (default: the one open in the app), --json, --yes
Categories: Session Log, Roleplay, Character, Quest, Location, Item, Lore, Misc.
`magicminutes help <command>` gives one command's usage and an example.

## Safety rules
- `notes add` and `campaigns add` save at once and only ever add.
- `notes import` and `import` show a plan and change nothing until you repeat them with
  `--yes`. Show the plan to the user first if in doubt.
- `import --replace --yes` deletes what is not in the file (after saving a backup). Use it
  only when the user asked to restore a backup.
- There is no delete command. Overwriting an existing output file needs `--yes`.
- `--campaign` never changes which campaign the app has open. An open app window won't
  show changes until the user reloads it.

## Note text format
    === Note ===
    Title: The sunken bell tower
    Category: Location
    Place: Greywater Marsh
    Tags: mystery, marsh

    Any text, over as many lines as you like.
    === End note ===
Only the title is needed. Put several notes one after another in a file.

## Example: copy notes from a file into a campaign
    magicminutes notes import session5.txt --campaign "Curse of the Marsh"
    magicminutes notes import session5.txt --campaign "Curse of the Marsh" --yes
The first call lists what would be added and changes nothing.

## Example: find what we know about X
    magicminutes notes search "ferryman"
    magicminutes notes show 1a2b3c4d
In PowerShell, put long or multi-line text in a file and use `notes import` or `run`
rather than a long `--text`. In `--text`, `\n` is a new line.
