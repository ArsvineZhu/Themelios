import { z } from "zod";
import { appError } from "./errors.js";
import type { ArtifactRef } from "./selection.js";

/** Fixed 1,024-unit table of case-sensitive four-letter tokenizer spellings. */
export const READABLE_CODEBOOK: readonly string[] = Object.freeze(
  [
    "userFilefileListUseritembaseLastformTextiterfromoverPOSTonlyfontPORTUSERaddrflagFORMTESTPATHLISTCOMPCONTFAILCOMMwithworkjsonGridunitTaskattrfindInitflowJSONNULLaxisREADITEMLOADCHAREDITBACKDOWNLEFTOPENINSTableTypevoidauthfillportViewarchItemforecentizedForm",
    "TestPathWithinitouteheadiconFromEditargsPostLinkBackusedoperhandWorkRectLongPortShowFontHTMLconsPlayfastFindSendStopanimajaxWORDLOCKHTTPfoodenumpingkeysexprARCHatomorigBOOLexitzoomUUIDWORKfeedemitVIEWPLAYCommITERflatMARKUNITTIMEfactPARTFROMfourCASTHEADSTAT",
    "RECTTRANLASTwordleftBaseuintLoadpartrestMainCoreimplcityringCODEheapappsNameviewbackcommcharopenReadbodyPartassehostUnitLeftinstWordFlagFILEAnimCopyoutshashNAMEintefreefootfireatteconvTickpeerfolduuidFREETEXTROOTHOSTimagmentenceselfDatacontendspostCallcast",
    "astecardImplplotchatMetaDATEappeLINEVertoncebitskindwirewaitcostfilmacciuartopolattsidervertbookpathModeCellfuncinercherengeiserareabandquerpassDrawjoinHostPermbindiferalerorerentifullBindquotaserpushiperhighTYPEallopairPACKBASEDATATRUEVERTAUTHhistCALLINIT",
    "quadADDRLINKFLAGWITHMASKARGSENUMplayantefaceendecompandectormarkrooteditanticonncopyconfattianniwrapencicartherewalkilibvarspermrespFACEitolHOMEightjectionsanceouldientatedountoundicaleneringsatchaterentsointContirstificaderatesicesveryaultagesamesitleente",
    "iousenseuresowerayerologategorldatusiverageridthichtoughasedTimeantsinesitedallyalthaturivesacheOverimesaticainseteritchadosThisinedistsrowseverurchencyelseorthHandacesfectivedillealeselleativquesoresonesatisfterversocusimerodesaperitesadasfortumerouchamos",
    "idesutesablyadesasesposeizerimumouthCompetchagedWhatanchovedidayiresjustixedicasisesischServsoftisedigeridosusesakerqualemosOpericosademidedoberalleizesCardAuthOpenStatometizaroderosedcingavesakesBookkingcoreelerarthToolBodyiritorgeidaseschodayEachThatimit",
    "aireokeramedVariNoneotesagemurerHashIGHTMarkonomoterolesiblyotosiberfordadowitosameraverhomeMENTivosYouravedicedquiscallipesesisabetomicatosimosOnlybootRootindiomasonymitasIteritetenasodedInstplusSortitatulerEnumapesLookAxisolicKeysalisManyurasPassosisHigh",
    "RoomenedirthLockasisumesTermppedapseblogRestULARikesJustzeitampsCartMockMostChatalenosesirusMathanasATEDffffovesFFFFBestoticMultJECTNESSumpsjourPromieuxPairCityflexapedigosamasArchKindCostitisMaskAttrikerweekzentWaitividGoodacerbankokeseticawayTERNicerbest",
    "FlowATCHquetonicacedellyicolShopSelfMeshirtsAddrivasivotorryFootakedPlusestrauerSlotulasLoopWeekExprINGSutchoremokedanosocomotteabolauptBankflixBootCLUDomerATORzingifikzeugPackudesoardulosFactjackopedPresorumuterNeedXXXXExitotedetryUsedittezungckerfangRank",
    "adedirtyismsDistPushCastDragopesemedfficigesamicCentoptsonedoseranstenezSentopicoleranesDoesREENorphDUCTapisIENTLessBitsVeryBuffICALLandoustfishemptelifprobuberimetetesICESanseFeedPrimLangZoomulptolasomesSuchpredosphProvFastWestElematemREAMDestMasszensomed",
    "NormenthPeeralinoonsciesetedPrevHookieurelemHistHardUSEDDarkuschicitollyhookullyWalkAlexHintfailComeBandVersRichagogulusimatzechMissIVERulumDiskumedfundorusurlscombieszcolsMustvalsowedenesematowejemetKingMartMontixeranskavisJackConvMODEPershouranntbuffodox",
    "alphuousSingDECLurstNINGittyoricfolkaggiemicATTRfersblesudedfracGUIDicusacreanthTINGCTRLolphierzfreqONLYSTERazedakovCONFalomacyjfeatCELLanedEXITasetOPERHANDTEMPHIGHPROPWARNousewardailsitalourswaysilesardsandsederargeillswingsteranksandaatalifuliateocoluper",
    "esteendailerachtairsallsArgsheidsetschesautoacksaresestsungsmainnderwoodartsicksancyordsMoreellsallaesseConsoolsSaveplaniersiansclipetztunteuchtindoNewswhatobbyongsocksatreulleargvaretobrecritRowselltForeTempINFORealialsastsoralitelMillolidactsarteTagsCert",
    "unciiestFillyingondsillywartadeluestilstwindPreforetGuidavidusalemanpromidelyersidalazarkersortsatelonalWrapiltyiffsSetspersoffsoldsappaourtCaptiantHeapCombfurtCOREolanangsoidsrentetheuffsFOREchippticiorsiensuityumbslineabelieldcondasoncomelistlessheckanel",
    "oneytestPageiledchedulesimalunchaintisonIconvingyearChariertailyidenoriaheetJsonpeedNextpackholdavelinderolevarientyaledagonemonclescellaponheititudendlTheyunesquirioniinsiMoveandijavagerszoneummyappyDescPropquelultyirosTeamheimprevhidecertabeiannyandyicia",
  ]
    .join("")
    .match(/.{4}/g)!,
);

const wordIndex = new Map<string, number>(
  READABLE_CODEBOOK.map((word, index) => [word, index]),
);
const maxReadable60 = (1n << 60n) - 1n;

const readable60Suffix = "[A-Za-z]{24}";
export const readable60Pattern = new RegExp(`^${readable60Suffix}$`);
export const agentArtifactRefPattern = new RegExp(`^art_${readable60Suffix}$`);

export function isReadable60(value: string): boolean {
  if (!readable60Pattern.test(value)) return false;
  for (let i = 0; i < 24; i += 4) {
    if (!wordIndex.has(value.slice(i, i + 4))) return false;
  }
  return true;
}

export function encodeReadable60(value: bigint): string {
  if (value < 0n || value > maxReadable60) {
    throw appError("input.invalid", {
      details: {
        issues: [
          { path: ["value"], reason: "Expected an unsigned 60-bit integer" },
        ],
      },
    });
  }
  let output = "";
  for (let shift = 50n; shift >= 0n; shift -= 10n) {
    const index = Number((value >> shift) & 0x3ffn);
    output += READABLE_CODEBOOK[index]!;
  }
  return output;
}

export function decodeReadable60(code: string): bigint {
  if (!readable60Pattern.test(code)) {
    throw appError("input.invalid", {
      details: {
        issues: [
          { path: ["code"], reason: "Expected a 24-character readable60 code" },
        ],
      },
    });
  }
  let value = 0n;
  for (let i = 0; i < 24; i += 4) {
    const idx = wordIndex.get(code.slice(i, i + 4));
    if (idx === undefined) {
      throw appError("input.invalid", {
        details: {
          issues: [{ path: ["code"], reason: "Unknown readable60 unit" }],
        },
      });
    }
    value = (value << 10n) | BigInt(idx);
  }
  return value;
}

export function generateReadable60(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return encodeReadable60(value & maxReadable60);
}

export const agentArtifactRefSchema = z
  .string()
  .regex(agentArtifactRefPattern)
  .refine((value) => isReadable60(value.slice(4)), "Unknown readable60 unit");

export type AgentArtifactRef = z.infer<typeof agentArtifactRefSchema>;

export function formatAgentArtifactRef(
  readable60Code: string,
): AgentArtifactRef {
  if (!isReadable60(readable60Code)) {
    throw appError("input.invalid", {
      details: {
        issues: [{ path: ["code"], reason: "Invalid readable60 code" }],
      },
    });
  }
  return ("art_" + readable60Code) as AgentArtifactRef;
}

export function parseAgentArtifactCode(value: string): string | undefined {
  if (!agentArtifactRefPattern.test(value)) return undefined;
  const code = value.slice(4);
  return isReadable60(code) ? code : undefined;
}

/** Bidirectional translator between canonical internal ArtifactRef values and token-efficient Agent references. */
export interface AgentRefBook {
  toAgent(ref: ArtifactRef): AgentArtifactRef;
  toCanonical(refOrAgentRef: string): string;
}

export function createAgentRefBook(): AgentRefBook {
  const toShort = new Map<ArtifactRef, AgentArtifactRef>();
  const toLong = new Map<string, ArtifactRef>();
  return {
    toAgent(ref) {
      const existing = toShort.get(ref);
      if (existing) return existing;
      let code: string;
      let candidate: AgentArtifactRef;
      do {
        code = generateReadable60();
        candidate = ("art_" + code) as AgentArtifactRef;
      } while (toLong.has(candidate));
      toShort.set(ref, candidate);
      toLong.set(candidate, ref);
      return candidate;
    },
    toCanonical(refOrAgentRef) {
      return toLong.get(refOrAgentRef) ?? refOrAgentRef;
    },
  };
}
