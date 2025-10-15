/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from '@google/genai';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const API_KEY = process.env.API_KEY;
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// --- DOM Elements ---
const tabUpload = document.getElementById('tab-upload') as HTMLButtonElement;
const tabLyrics = document.getElementById('tab-lyrics') as HTMLButtonElement;
const panelUpload = document.getElementById('panel-upload') as HTMLDivElement;
const panelLyrics = document.getElementById('panel-lyrics') as HTMLDivElement;
const fileInput = document.getElementById('file-upload') as HTMLInputElement;
const uploadArea = document.querySelector('.custom-file-upload') as HTMLLabelElement;
const fileNameSpan = document.getElementById('file-name') as HTMLSpanElement;
const lyricsInput = document.getElementById('lyrics-input') as HTMLTextAreaElement;
const uploadLyricsInput = document.getElementById('upload-lyrics-input') as HTMLTextAreaElement;
const submitButton = document.getElementById('submit-button') as HTMLButtonElement;
const loader = document.getElementById('loader') as HTMLDivElement;
const resultContainer = document.getElementById('result-container') as HTMLElement;
const resultText = document.getElementById('result-text') as HTMLDivElement;
const modelSelector = document.getElementById('model-selector') as HTMLSelectElement;
const scoreSummaryContainer = document.getElementById('score-summary-container') as HTMLElement;


// --- App State ---
let activeTab: 'upload' | 'lyrics' = 'upload';
let audioFile: File | null = null;

// --- Gemini AI Setup ---
const ai = new GoogleGenAI({ apiKey: API_KEY });

const responseSchema = {
    type: Type.OBJECT,
    properties: {
        isInstrumental: {
            type: Type.BOOLEAN,
            description: "Set to true if the audio track contains no discernible sung or rapped vocals, false otherwise."
        },
        aiGeneratedLyrics: {
            type: Type.OBJECT,
            description: "An assessment of whether the lyrics appear to be AI-generated. This field is null if the confidence is low or if the track is instrumental.",
            properties: {
                isDetected: { type: Type.BOOLEAN, description: "True if the lyrics are likely AI-generated." },
                justification: { type: Type.STRING, description: "A brief explanation for the detection assessment." }
            },
            required: ["isDetected", "justification"],
            nullable: true
        },
        aiGeneratedMusic: {
            type: Type.OBJECT,
            description: "An assessment of whether the music appears to be AI-generated. This field is null if the confidence is low.",
            properties: {
                isDetected: { type: Type.BOOLEAN, description: "True if the music is likely AI-generated." },
                justification: { type: Type.STRING, description: "A brief explanation for the music AI detection assessment (e.g., sterile production, unnatural patterns)." }
            },
            required: ["isDetected", "justification"],
            nullable: true
        },
        musicalAnalysis: {
            type: Type.OBJECT,
            description: "A harsh, deep, and objective critique of the music itself, broken down into distinct sections. This entire object must be null if no audio file was provided.",
            properties: {
                instrumentationAndArrangement: {
                    type: Type.STRING,
                    description: "Critique of the choice of instruments, how they interact, and the overall arrangement."
                },
                productionAndMix: {
                    type: Type.STRING,
                    description: "Analysis of the recording quality, mix clarity, use of effects, dynamics, and mastering."
                },
                compositionAndStructure: {
                    type: Type.STRING,
                    description: "Evaluation of the song's structure, melody, harmony, rhythm, and overall compositional strength."
                },
                overallImpression: {
                    type: Type.STRING,
                    description: "A summary of the musical analysis and its overall impact."
                }
            },
            required: ["instrumentationAndArrangement", "productionAndMix", "compositionAndStructure", "overallImpression"],
            nullable: true
        },
        lyricalAnalysis: {
            type: Type.OBJECT,
            description: "A comprehensive analysis of the lyrics based on the provided rubric. This entire object MUST be null if 'isInstrumental' is true.",
            properties: {
                scorecard: {
                    type: Type.ARRAY,
                    description: "An array containing the score and justification for each lyrical category.",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            category: { type: Type.STRING, description: "The name of the scoring category (e.g., 'Theme and Concept')." },
                            score: { type: Type.NUMBER, description: "The score awarded for this category." },
                            maxScore: { type: Type.NUMBER, description: "The maximum possible score for this category (e.g., 10 for Theme and Concept)." },
                            justification: { type: Type.STRING, description: "Detailed, evidence-based justification for the score, citing specific lyrics." }
                        },
                        required: ["category", "score", "maxScore", "justification"]
                    }
                },
                subtotal: { type: Type.NUMBER, description: "The sum of all scores from the scorecard." },
                penalties: { type: Type.NUMBER, description: "The total points deducted for penalties. Must be 0 if no penalties apply." },
                finalScore: { type: Type.NUMBER, description: "The subtotal minus penalties, rounded to the nearest integer." },
                scoreLowerBound: { type: Type.NUMBER, description: "The lower bound of the confidence interval for the final score." },
                scoreUpperBound: { type: Type.NUMBER, description: "The upper bound of the confidence interval for the final score." },
                interpretation: { type: Type.STRING, description: "The final score's corresponding interpretation text (e.g., 'Canon-level craft; rare.')." },
                areasForImprovement: {
                    type: Type.STRING,
                    description: "A bulleted list in markdown format of 2-3 concrete, actionable suggestions for improving the lyrics, directly tied to weaknesses identified in the scorecard."
                }
            },
            required: ["scorecard", "subtotal", "penalties", "finalScore", "scoreLowerBound", "scoreUpperBound", "interpretation", "areasForImprovement"]
        }
    },
    required: ["isInstrumental", "musicalAnalysis"]
};

const systemInstruction = `You are a discerning and expert music critic. Your function is to apply the provided scoring rubric with objectivity, fairness, and deep musical knowledge. Your output MUST be a single, valid JSON object conforming to the provided schema and nothing else.

**Core Principles & Directives:**
1.  **Expert Objectivity:** Your analysis must be analytical and evidence-based.
2.  **Calibrated Scoring (Dynamic Range):** You MUST use the full 0-100 scale for lyrics. Most professionally written but unremarkable songs will fall in the 50-70 range. Do not hesitate to award scores below 40 for poor work or scores above 90 for canon-level masterworks. Avoid clustering scores.
3.  **Balanced Judgment:** Your critique must weigh a song's weaknesses against its strengths and artistic ambitions.

**METHODOLOGY (AUDIO FILE):**
1.  **Instrumental Detection (MANDATORY FIRST STEP):** You MUST first determine if the track is an instrumental (contains no discernible sung or rapped vocals). Set the 'isInstrumental' flag to 'true' or 'false'. This is the most critical step.
2.  **AI Music Detection:** Analyze the musical composition for signs of AI generation (e.g., sterile production, unnatural patterns, lack of cohesive structure). If there is moderate to high confidence, populate the 'aiGeneratedMusic' field; otherwise, leave it null.
3.  **Deep Musical Analysis:** Compose the 'musicalAnalysis' object. Your critique must go beyond surface-level observations.
    *   **instrumentationAndArrangement:** Analyze the choice and interplay of instruments.
    *   **productionAndMix:** Critique the mix clarity, dynamics, and overall sonic texture. Be specific and technical.
    *   **compositionAndStructure:** Evaluate the melody, harmony, rhythm, and song structure.
    *   **overallImpression:** Provide a concluding summary of the music's impact.
4.  **Conditional Lyrical Analysis:**
    *   IF 'isInstrumental' is 'true', the 'lyricalAnalysis' field in the JSON output MUST BE NULL.
    *   IF 'isInstrumental' is 'false', you must proceed with the full lyrical analysis as defined in the "METHODOLOGY (LYRICS)" section.

**METHODOLOGY (LYRICS - Only if NOT instrumental):**
1.  **AI-Generated Lyrics Check:** Analyze the lyrics for patterns, clichés, or structures typical of AI generation. If there is moderate to high confidence, populate the 'aiGeneratedLyrics' field; otherwise, leave it null.
2.  **Internal Cognitive Model (MANDATORY PRE-COMPUTATION):** Before constructing the JSON output, you MUST perform a silent, internal, step-by-step analysis for each lyrical category.
    a.  **Evidence Gathering (Strengths vs. Weaknesses):** Systematically extract 1-2 specific examples of the STRONGEST aspects and 1-2 examples of the WEAKEST aspects.
    b.  **Score Deliberation:** Based on the balance of evidence, internally decide on a score.
    c.  **Justification Formulation:** Write a draft justification that explicitly references the evidence.
    d.  **Sanity Check:** Review your scores. Do they use a dynamic range? Is the final score a fair reflection of the song's overall quality?
    e.  **Final JSON Construction:** Only after completing this rigorous internal process, construct the 'lyricalAnalysis' part of the JSON output.
3.  **Populate Lyrical Analysis Object:** Fill out all fields in the 'lyricalAnalysis' object based on your internal model.

**LYRICAL CRITICISM RUBRIC (WEIGHTS SUM TO 100):**

*   **Theme and Concept (10 pts):** Cohesion and depth of the central idea.
*   **Imagery and Language (15 pts):** Freshness, specificity, and sensory detail.
*   **Narrative and Structure (10 pts):** Logical/emotional progression and structural integrity.
*   **Voice and Point of View (8 pts):** Consistency and distinctiveness of the narrator/character.
*   **Emotional Authenticity and Impact (15 pts):** Believability and resonance of emotion.
*   **Prosody and Singability (10 pts):** Natural flow, rhythm, and phonetic appeal.
*   **Rhyme and Poetic Technique (10 pts):** Skillful use of rhyme, alliteration, assonance, etc.
*   **Originality and Risk (10 pts):** Uniqueness of concept, perspective, or execution.
*   **Cohesion and Line Economy (6 pts):** How well lines connect and avoid filler.
*   **Memorability and Hook Quotient (6 pts):** The sticking power of key phrases or ideas.

**SCORE INTERPRETATION RANGES:**

*   **90–100:** Canon-level craft; rare.
*   **80–89:** Excellent; multiple standout strengths.
*   **70–79:** Strong; clear competence with notable moments.
*   **60–69:** Good but flawed; some filler or conventionality.
*   **50–59:** Serviceable; functional writing with limited freshness.
*   **40–49:** Weak; clichés, flat images, or slack structure.
*   **30–39:** Poor; confused voice or heavy padding.
*   **0–29:** Nonfunctional as writing.

Your entire output must be a single, valid JSON object that conforms to the schema. Do not include any text, markdown formatting, or explanations outside of the JSON structure.
`;

// --- Utility Functions ---
/**
 * Converts a file to a base64 encoded string.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      // remove the "data:mime/type;base64," prefix
      resolve(result.split(',')[1]);
    };
    reader.onerror = (error) => reject(error);
  });
}

/**
 * Updates the state of the submit button.
 */
function updateSubmitButtonState() {
  const lyrics = lyricsInput.value.trim();
  const file = fileInput.files?.[0];
  if ((activeTab === 'lyrics' && lyrics) || (activeTab === 'upload' && file)) {
    submitButton.disabled = false;
  } else {
    submitButton.disabled = true;
  }
}

/**
 * Renders the critique from a structured JSON object into the main output panel.
 */
async function renderCritique(critiqueData: any) {
  let finalHtml = '';

  // Render Musical Analysis if it exists
  if (critiqueData.musicalAnalysis && typeof critiqueData.musicalAnalysis === 'object') {
    finalHtml += `<h2>Musical Analysis</h2>`;

    // Always render AI Music Detection status
    if (critiqueData.aiGeneratedMusic?.isDetected === true) {
        finalHtml += `
          <div class="ai-detection-summary">
              <p><strong>AI Music Detected:</strong> Our analysis suggests the musical composition may have been generated or heavily assisted by AI.</p>
              <p>${DOMPurify.sanitize(critiqueData.aiGeneratedMusic.justification)}</p>
          </div>
        `;
    } else {
        finalHtml += `
          <div class="ai-detection-summary neutral">
              <p><strong>AI Music Detection:</strong> No clear indicators of AI generation were found in the musical composition.</p>
          </div>
        `;
    }

    const analysis = critiqueData.musicalAnalysis;

    if (analysis.instrumentationAndArrangement) {
        finalHtml += `<h3>Instrumentation & Arrangement</h3>`;
        finalHtml += await marked.parse(analysis.instrumentationAndArrangement);
    }
    if (analysis.productionAndMix) {
        finalHtml += `<h3>Production & Mix</h3>`;
        finalHtml += await marked.parse(analysis.productionAndMix);
    }
    if (analysis.compositionAndStructure) {
        finalHtml += `<h3>Composition & Structure</h3>`;
        finalHtml += await marked.parse(analysis.compositionAndStructure);
    }
    if (analysis.overallImpression) {
        finalHtml += `<h3>Overall Impression</h3>`;
        finalHtml += await marked.parse(analysis.overallImpression);
    }
  }
  
  // Render Lyrical Analysis OR Instrumental notice
  if (critiqueData.isInstrumental) {
      finalHtml += `<h2>Lyrical Analysis</h2>`;
      finalHtml += `<p><em>Instrumental track detected. Lyrical analysis has been skipped.</em></p>`;
  } else if (critiqueData.lyricalAnalysis) {
    const lyricalData = critiqueData.lyricalAnalysis;
    finalHtml += `<h2>Lyrical Analysis</h2>`;

    // Always render AI Lyrics Detection status
    if (critiqueData.aiGeneratedLyrics?.isDetected === true) {
        finalHtml += `
          <div class="ai-detection-summary">
              <p><strong>AI Lyrics Detected:</strong> Our analysis suggests the lyrics may have been generated or heavily assisted by AI.</p>
              <p>${DOMPurify.sanitize(critiqueData.aiGeneratedLyrics.justification)}</p>
          </div>
        `;
    } else {
        finalHtml += `
          <div class="ai-detection-summary neutral">
              <p><strong>AI Lyrics Detection:</strong> No clear indicators of AI generation were found in the lyrics.</p>
          </div>
        `;
    }
    
    if (lyricalData.scorecard && Array.isArray(lyricalData.scorecard)) {
        for (const item of lyricalData.scorecard) {
            finalHtml += `<h4>${item.category} (${item.score} / ${item.maxScore})</h4>`;
            finalHtml += await marked.parse(item.justification);
        }
    }

    finalHtml += `<h3>Final Score & Interpretation</h3>`;
    finalHtml += `<p><strong>Subtotal:</strong> ${lyricalData.subtotal} / 100</p>`;
    if (lyricalData.penalties > 0) {
        finalHtml += `<p><strong>Penalties:</strong> -${lyricalData.penalties}</p>`;
    }
    finalHtml += `<p><strong>Final Score:</strong> ${lyricalData.finalScore} / 100</p>`;
    finalHtml += `<p><strong>Confidence Interval:</strong> ${lyricalData.scoreLowerBound} - ${lyricalData.scoreUpperBound}</p>`;
    finalHtml += `<blockquote>${DOMPurify.sanitize(lyricalData.interpretation)}</blockquote>`;

    if (lyricalData.areasForImprovement) {
        finalHtml += `<h3>Areas for Improvement</h3>`;
        finalHtml += await marked.parse(lyricalData.areasForImprovement);
    }
  }
  
  resultText.innerHTML = DOMPurify.sanitize(finalHtml, {ADD_TAGS: ["div"], ADD_ATTR: ["class"]});
}

/**
 * Renders a structured summary of scores in the input panel.
 */
function renderScoreSummary(critiqueData: any) {
  // If instrumental or no lyrical data, hide the summary
  if (critiqueData.isInstrumental || !critiqueData.lyricalAnalysis) {
    scoreSummaryContainer.hidden = true;
    return;
  }

  const lyricalData = critiqueData.lyricalAnalysis;
  if (!lyricalData.scorecard) {
      scoreSummaryContainer.hidden = true;
      return;
  }

  let summaryHtml = `<h3>Score Summary</h3>`;

  for (const item of lyricalData.scorecard) {
    summaryHtml += `
      <div class="score-item">
        <span class="category">${DOMPurify.sanitize(item.category)}</span>
        <span class="score">${item.score} / ${item.maxScore}</span>
      </div>
    `;
  }

  summaryHtml += `<div class="score-summary-divider"></div>`;

  summaryHtml += `
    <div class="total-score">
      <span>Final Score</span>
      <span>${lyricalData.finalScore} / 100</span>
    </div>
  `;
  
  scoreSummaryContainer.innerHTML = summaryHtml;
  scoreSummaryContainer.hidden = false;
}

// --- Event Handlers ---
function handleTabClick(tab: 'upload' | 'lyrics') {
  activeTab = tab;
  if (tab === 'upload') {
    tabUpload.classList.add('active');
    tabUpload.setAttribute('aria-selected', 'true');
    panelUpload.hidden = false;

    tabLyrics.classList.remove('active');
    tabLyrics.setAttribute('aria-selected', 'false');
    panelLyrics.hidden = true;
  } else {
    tabLyrics.classList.add('active');
    tabLyrics.setAttribute('aria-selected', 'true');
    panelLyrics.hidden = false;

    tabUpload.classList.remove('active');
    tabUpload.setAttribute('aria-selected', 'false');
    panelUpload.hidden = true;
  }
  updateSubmitButtonState();
}

/**
 * Handles file selection, validation, and state update.
 */
function handleFileSelect(file: File | null) {
  const resetFileState = () => {
    fileInput.value = ''; // Reset file input
    audioFile = null;
    fileNameSpan.textContent = 'No file selected';
  };
  
  if (file) {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      alert(`File is too large. Please select a file smaller than ${MAX_FILE_SIZE_MB} MB.`);
      resetFileState();
    } else if (!file.type.startsWith('audio/')) {
      alert('Invalid file type. Please select an audio file.');
      resetFileState();
    } else {
      audioFile = file;
      fileNameSpan.textContent = file.name;
    }
  } else {
    resetFileState();
  }
  updateSubmitButtonState();
}

function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0] ?? null;
  handleFileSelect(file);
}

async function handleSubmit() {
  submitButton.disabled = true;
  loader.hidden = false;
  resultContainer.setAttribute('aria-busy', 'true');
  resultText.innerHTML = 'Your music critique will appear here.';
  scoreSummaryContainer.hidden = true;
  scoreSummaryContainer.innerHTML = '';

  try {
    let contents;
    if (activeTab === 'upload' && audioFile) {
      const base64Audio = await fileToBase64(audioFile);
      const userLyrics = uploadLyricsInput.value.trim();
      const promptText = userLyrics
        ? `Critique this song. The user has provided the following lyrics to consider in your analysis:\n\n${userLyrics}`
        : "Critique this song. First, determine if it is an instrumental. Provide a deep musical analysis. If it contains vocals, also provide a full lyrical analysis based on your rubric.";

      contents = {
        parts: [
          { text: promptText },
          {
            inlineData: {
              mimeType: audioFile.type,
              data: base64Audio,
            },
          },
        ],
      };
    } else if (activeTab === 'lyrics') {
      const lyrics = lyricsInput.value;
      // For lyrics-only input, we know it's not an instrumental and has no music to analyze.
      // FIX: The `default` property does not exist on the schema type. The `modifiedSchema` block was also unused.
      // Instead, we explicitly instruct the model in the prompt to handle this case correctly.
      const promptText = `Critique the following song lyrics. Since no audio file was provided, you must treat this as a lyrics-only analysis. In your JSON response, you MUST set 'isInstrumental' to false, and 'musicalAnalysis' and 'aiGeneratedMusic' to null.\n\nLyrics:\n\n${lyrics}`;
      contents = { parts: [{ text: promptText }] };
    } else {
      throw new Error('No valid input provided.');
    }

    const selectedModel = modelSelector.value;
    const temperature = selectedModel === 'gemini-2.5-pro' ? 0.1 : 0;

    const response = await ai.models.generateContent({
      model: selectedModel,
      contents,
      config: {
        systemInstruction,
        temperature: temperature,
        responseMimeType: 'application/json',
        responseSchema,
      },
    });
    
    try {
        const jsonString = response.text.trim();
        const critiqueData = JSON.parse(jsonString);
        await renderCritique(critiqueData);
        renderScoreSummary(critiqueData);
    } catch (parseError) {
        console.error("Failed to parse JSON response from AI:", parseError);
        console.error("Raw AI response:", response.text);
        resultText.textContent = 'An error occurred while parsing the AI response. The response may not be valid JSON. Please check the console for details.';
    }

  } catch (error) {
    console.error(error);
    resultText.textContent = `An error occurred while analyzing the song. The file might be corrupted or exceed the ${MAX_FILE_SIZE_MB}MB size limit. Please check the console for details and try again.`;
  } finally {
    loader.hidden = true;
    resultContainer.setAttribute('aria-busy', 'false');
    updateSubmitButtonState();
  }
}

// --- Initialization ---
function main() {
  tabUpload.addEventListener('click', () => handleTabClick('upload'));
  tabLyrics.addEventListener('click', () => handleTabClick('lyrics'));
  fileInput.addEventListener('change', handleFileChange);
  lyricsInput.addEventListener('input', updateSubmitButtonState);
  uploadLyricsInput.addEventListener('input', updateSubmitButtonState);
  submitButton.addEventListener('click', handleSubmit);

  // Drag and drop event listeners
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove('dragover');
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      handleFileSelect(files[0]);
      fileInput.files = files;
    }
  });

  uploadLyricsInput.addEventListener('input', updateSubmitButtonState);
}

main();