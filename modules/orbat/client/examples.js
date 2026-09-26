/**
 * Built-in example ORBATs, in the same shape as `GET orbats/:id/export` /
 * `POST orbats/import` (nested, no ids). "New from example" posts one of
 * these straight to the import endpoint.
 */

import { DEFAULT_SIDC, withFields } from '../../../src/symbols/sidc.js';

function sidcFor({
  echelon = '00',
  entity = '121100',
  hqtfd = '0',
  modifier1 = '00',
  modifier2 = '00',
} = {}) {
  return withFields(DEFAULT_SIDC, { amplifier: echelon, entity, hqtfd, modifier1, modifier2 });
}

function unit({
  sidc,
  name,
  designation = '',
  higherFormation = '',
  reinforced = '',
  additional = '',
  notes = '',
  children = [],
}) {
  return { sidc, name, designation, higherFormation, reinforced, additional, notes, children };
}

const ECHELON = {
  team: '11',
  squad: '12',
  section: '13',
  platoon: '14',
  company: '15',
  battalion: '16',
  regiment: '17',
  brigade: '18',
};
const ENTITY = {
  mechInfantry: '121102',
  antiArmour: '120400',
  armour: '120500',
  mortar: '130800',
  sustainment: '160000',
  allSupply: '160200',
  maintenance: '161100',
  medical: '161300',
};
/** Sector 1 modifiers. */
const MODIFIER1 = { weapons: '85', headquarters: '98' };

function platoon(letter, higherFormation) {
  return unit({
    sidc: sidcFor({ echelon: ECHELON.platoon, entity: ENTITY.mechInfantry }),
    name: `${letter} Platoon`,
    designation: letter,
    higherFormation,
  });
}

function mechCompany(letter, higherFormation) {
  return unit({
    sidc: sidcFor({ echelon: ECHELON.company, entity: ENTITY.mechInfantry }),
    name: `${letter} Company`,
    designation: letter,
    higherFormation,
    children: [platoon('1', letter), platoon('2', letter), platoon('3', letter)],
  });
}

/** HQ company + three mechanized infantry companies × three platoons, a weapons company and a combat trains element. */
function mechanizedBattalion() {
  return {
    format: 'orbat',
    version: 1,
    name: 'Mechanized infantry battalion',
    description:
      'A headquarters company, three mechanized infantry companies of three platoons each, a weapons company and battalion trains — the classic fan-and-stack shape.',
    units: [
      unit({
        sidc: sidcFor({ echelon: ECHELON.battalion, entity: ENTITY.mechInfantry }),
        name: '1st Battalion, 4th Mechanized Infantry',
        designation: '1-4',
        children: [
          unit({
            sidc: sidcFor({
              echelon: ECHELON.company,
              entity: ENTITY.mechInfantry,
              modifier1: MODIFIER1.headquarters,
            }),
            name: 'Headquarters Company',
            designation: 'HHC',
            higherFormation: '1-4',
          }),
          mechCompany('A', '1-4'),
          mechCompany('B', '1-4'),
          mechCompany('C', '1-4'),
          unit({
            sidc: sidcFor({
              echelon: ECHELON.company,
              entity: ENTITY.mechInfantry,
              modifier1: MODIFIER1.weapons,
            }),
            name: 'Weapons Company',
            designation: 'D',
            higherFormation: '1-4',
            children: [
              unit({
                sidc: sidcFor({ echelon: ECHELON.platoon, entity: ENTITY.mortar }),
                name: 'Mortar Platoon',
                designation: '1',
                higherFormation: 'D',
              }),
              unit({
                sidc: sidcFor({ echelon: ECHELON.platoon, entity: ENTITY.antiArmour }),
                name: 'Anti-armour Platoon',
                designation: '2',
                higherFormation: 'D',
              }),
            ],
          }),
          unit({
            sidc: sidcFor({ echelon: ECHELON.company, entity: ENTITY.sustainment }),
            name: 'Forward Support Company',
            designation: 'FSC',
            higherFormation: '1-4',
            children: [
              unit({
                sidc: sidcFor({ echelon: ECHELON.platoon, entity: ENTITY.maintenance }),
                name: 'Maintenance Platoon',
                higherFormation: 'FSC',
              }),
              unit({
                sidc: sidcFor({ echelon: ECHELON.platoon, entity: ENTITY.medical }),
                name: 'Medical Platoon',
                higherFormation: 'FSC',
              }),
              unit({
                sidc: sidcFor({ echelon: ECHELON.platoon, entity: ENTITY.allSupply }),
                name: 'Supply Platoon',
                higherFormation: 'FSC',
              }),
            ],
          }),
        ],
      }),
    ],
  };
}

/** A single reinforced armoured company: HQ, three tank platoons and an attached mortar section — a compact, all-leaf stack. */
function reinforcedArmouredCompany() {
  return {
    format: 'orbat',
    version: 1,
    name: 'Reinforced armoured company',
    description:
      'A tank company reinforced with an attached mortar section: a small example for a first look at the builder.',
    units: [
      unit({
        sidc: sidcFor({ echelon: ECHELON.company, entity: ENTITY.armour }),
        name: 'Bravo Company, 3rd Tank Battalion',
        designation: 'B',
        higherFormation: '3',
        reinforced: '(+)',
        children: [
          unit({
            sidc: sidcFor({ echelon: ECHELON.platoon, entity: ENTITY.armour }),
            name: '1st Platoon',
            designation: '1',
            higherFormation: 'B',
          }),
          unit({
            sidc: sidcFor({ echelon: ECHELON.platoon, entity: ENTITY.armour }),
            name: '2nd Platoon',
            designation: '2',
            higherFormation: 'B',
          }),
          unit({
            sidc: sidcFor({ echelon: ECHELON.platoon, entity: ENTITY.armour }),
            name: '3rd Platoon',
            designation: '3',
            higherFormation: 'B',
          }),
          unit({
            sidc: sidcFor({ echelon: ECHELON.section, entity: ENTITY.mortar }),
            name: 'Mortar Section (attached)',
            higherFormation: 'B',
            additional: 'ATT',
          }),
        ],
      }),
    ],
  };
}

/** Each entry: `{ id, name, description, build() }`; `build()` returns the import-format document (`{ name, description, units }`). */
export const EXAMPLES = [
  {
    id: 'mechanized-battalion',
    name: 'Mechanized infantry battalion',
    description: mechanizedBattalion().description,
    build: mechanizedBattalion,
  },
  {
    id: 'reinforced-company',
    name: 'Reinforced armoured company',
    description: reinforcedArmouredCompany().description,
    build: reinforcedArmouredCompany,
  },
];
