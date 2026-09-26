# IPB workbench

An offline intelligence-staff workbench: IPB studies on a local map, orders of battle, and a staff exercise run by exercise control against a training audience, all on one LAN server.

## Exercise and people

**Exercise**:
The one training event currently running on the server, with its own name, members and data; earlier ones exist only as archives.
_Avoid_: session, game

**Archive**:
A frozen copy of an exercise's data and member list, kept for review and restorable later.
_Avoid_: snapshot, backup (a backup is the operator's copy of all server data, not one exercise)

**Cell**:
One of the three teams in an exercise: White (exercise control), Blue (training audience) or Red (opposing force).
_Avoid_: team, side, faction

**Member**:
An account's place in the current exercise: one cell and one role.
_Avoid_: roster entry, participant

**Role**:
What a member may do within their cell, lowest to highest: observer, analyst, collection-manager, game-master.
_Avoid_: permission, rank

**Admin**:
An account allowed to manage accounts, members and the exercise itself; sees every cell's items.
_Avoid_: superuser, administrator role

## Ownership and sharing

**Cell-owned item**:
A study, ORBAT, requirement, report, RFI, track, collector, tasking, INTSUM, NAI or message: something that belongs to exactly one cell.
_Avoid_: resource, record, document

**Part**:
Something that exists only inside a cell-owned item (a study's threats, an ORBAT's units, a requirement's SIRs, indicators and evidence links, a track's positions) and is seen and changed exactly as its item is.
_Avoid_: child row, sub-item

**Evidence link**:
A part of a requirement recording that a report the requirement's cell can read confirms, denies, partly answers or gives context to it.
_Avoid_: citation, evidence (alone)

**Owner cell**:
The cell a cell-owned item belongs to; that cell (and White) may change it.
_Avoid_: owner (alone), author

**Release**:
Letting other cells read a cell-owned item; a release never lets them change it.
_Avoid_: share, publish

**Reassign**:
White moving a cell-owned item to a different owner cell.
_Avoid_: transfer, hand over

**Inject**:
A scheduled event White prepares in advance (a report or a message) that fires at a scenario time and is released to chosen cells.
_Avoid_: event (alone), scenario event
