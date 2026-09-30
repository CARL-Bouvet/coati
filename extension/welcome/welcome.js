// Welcome page (docs/DECISIONS.md T51) — opened once by the service worker's
// runtime.onInstalled when reason === "install", never on an update. Static
// content: pin the icon (wording per engine), the three first-launch steps,
// the installer link. Reads nothing, sends nothing to the broker.

import { api, IS_GECKO } from "../lib/browser-compat.js";
import { RELEASES_URL } from "../panel/first-run.js";

// --- User-facing strings (French; G6 moves them to _locales) --------------
const TEXT = {
  pageTitle: "Bienvenue dans Coati",
  title: "Bienvenue dans Coati",
  lead: "Coati résume une page ou une vidéo et répond à vos questions sur ce que vous lisez, avec le modèle de votre choix, par un programme qui tourne sur votre machine.",
  pinTitle: "Épinglez l'icône",
  pinBrowserChromium: "Chrome, Brave, Edge",
  pinBrowserGecko: "Firefox",
  pinStepsChromium: [
    "Cliquez sur l'icône des extensions (la pièce de puzzle), à droite de la barre d'adresse.",
    "Cliquez sur l'épingle à côté de « Coati ».",
    "L'icône de Coati reste alors dans la barre d'outils : un clic ouvre le panneau.",
  ],
  pinStepsGecko: [
    "Cliquez sur le bouton des extensions (la pièce de puzzle), à droite de la barre d'adresse.",
    "Cliquez sur la roue dentée à côté de « Coati », puis sur « Épingler à la barre d'outils ».",
    "L'icône de Coati reste alors dans la barre d'outils : un clic ouvre la barre latérale.",
  ],
  stepsTitle: "Trois étapes",
  programTitle: "Installez le programme local",
  programText: "Coati passe par un petit programme installé sur votre ordinateur : c'est lui qui parle au modèle et garde vos clés, jamais l'extension.",
  programLink: "Télécharger le programme",
  modelTitle: "Choisissez un modèle",
  modelText: "Dans les réglages : un modèle qui tourne chez vous (Ollama), ou un service en ligne avec votre propre clé.",
  modelAction: "Ouvrir les réglages",
  pageTitleStep: "Ouvrez Coati sur une page",
  pageTextChromium: "Cliquez sur l'icône de Coati, puis sur « Lire cette page » en haut du panneau. Le navigateur vous demandera une fois l'accès à tous les sites.",
  pageTextGecko: "Cliquez sur l'icône de Coati, puis sur « Lire cette page » en haut de la barre latérale. Firefox vous demandera une fois l'accès à tous les sites.",
  gesture: "Coati ne lit une page que lorsque vous cliquez : jamais en arrière-plan, jamais en changeant d'onglet.",
};

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

document.title = TEXT.pageTitle;
setText("welcomeTitle", TEXT.title);
setText("welcomeLead", TEXT.lead);
setText("pinTitle", TEXT.pinTitle);
setText("pinBrowser", IS_GECKO ? TEXT.pinBrowserGecko : TEXT.pinBrowserChromium);
document.getElementById("pinSteps").replaceChildren(
  ...(IS_GECKO ? TEXT.pinStepsGecko : TEXT.pinStepsChromium).map((step) => {
    const li = document.createElement("li");
    li.textContent = step;
    return li;
  }),
);
setText("stepsTitle", TEXT.stepsTitle);
setText("stepProgramTitle", TEXT.programTitle);
setText("stepProgramText", TEXT.programText);
const programLink = document.getElementById("stepProgramLink");
programLink.href = RELEASES_URL;
programLink.textContent = TEXT.programLink;
setText("stepModelTitle", TEXT.modelTitle);
setText("stepModelText", TEXT.modelText);
const modelAction = document.getElementById("stepModelAction");
modelAction.textContent = TEXT.modelAction;
modelAction.addEventListener("click", () => api.runtime.openOptionsPage());
setText("stepPageTitle", TEXT.pageTitleStep);
setText("stepPageText", IS_GECKO ? TEXT.pageTextGecko : TEXT.pageTextChromium);
setText("welcomeGesture", TEXT.gesture);
