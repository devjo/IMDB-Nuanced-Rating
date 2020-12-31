// ==UserScript==
// @name         IMDB Nuanced Rating
// @namespace    https://github.com/devjo
// @version      0.2.3
// @description  Normalizes the IMDB rating by supressing impact of 1 and 10 review bombing. Also indicates who the movie/series is aimed at.
// @author       devjo
// @license      GPL-3.0-or-later; https://www.gnu.org/licenses/gpl-3.0.txt
// @match        https://www.imdb.com/title/*
// @updateURL    https://openuserjs.org/meta/devjo/IMDB_Nuanced_Rating.meta.js
// @downloadURL  https://openuserjs.org/install/devjo/IMDB_Nuanced_Rating.user.js
// @copyright    2020, devjo (https://openuserjs.org/users/devjo)
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Only trigger on the title page
  if (!window.location.pathname.match(/\/tt\d+\/$/)) return;

  // Constants
  const baseURL = window.location.pathname;
  const ratingURL = baseURL + 'ratings';
  const femaleRatingURL = baseURL + 'ratings?demo=females';
  const maleRatingURL = baseURL + 'ratings?demo=males';
  const childRatingURL = baseURL + 'ratings?demo=aged_under_18';

  // =[ Helpers ]==================
  const $c = (expr, root) => Array.from((root||document).querySelectorAll(expr));
  const isAsync = f => f instanceof (async () => {}).constructor;
  function assert(value, msg) {
    if (value == undefined || value == null) throw msg;
    return value;
  }
  function log(...args) {
    console.debug('NuancedRating', ...args);
  }

  // TTL cache of function return values. Provided function can be either sync or async.
  // Always returns a promise that needs to be resolved to get the function return value.
  async function cache(key, f) {
    const TTL = 7200 * 1000;  // Cache for 2 hours
    return new Promise(async resolve => {

      // If fresh in cache, return cached value
      if (key in localStorage) {
        const item = JSON.parse(localStorage[key]);
        const since = new Date().getTime() - item.stored;
        const expired = since > TTL;
        if (!expired) {
          resolve(item.value);
          return;
        }
      }

      // Either not in cache or expired, so try to refresh
      let value;
      if (isAsync(f)) {
        value = await f();
      } else {
        value = f();
      }

      if (value != undefined && value != null) {
        localStorage[key] = JSON.stringify({
          stored: new Date().getTime(),
          value: value
        });
      }
      resolve(value);
    });
  }

  async function fetchDoc(url) {
    return fetch(url)
      .then(req => req.text())
      .then(html => new DOMParser().parseFromString(html, 'text/html'));
  }
  // =[ END Helpers ]==============

  // Extract the voting statistics from the ratings page
  function extractVoteStats(doc) {
    const rows = $c('.article.listo table[cellpadding] tr', doc).slice(1);
    if (rows.length != 10) {
      const isChildPage = $c('.sectionHeading', doc).map(e => e.textContent.trim()).filter(s => s == "Under 18").length == 1;
      // No child has rated the title, so fake something as it won't be used anyway.
      if(isChildPage) {
        return [{ score: 1, votes: 1}];
      } else {
        throw 'BUG: Failed to find the score rows on the ratings page';
      }
    }

    return rows.map(row => {
      return {
        score: +$c('.rightAligned', row)[0].textContent,
        votes: +$c('.leftAligned', row)[0].textContent.replace(/[,.]/g, ''),
      };
    });
  }

  // Penalize 10 and 1 votes when computing a more reasonable title rating.
  // Algo from ChoFlojT: https://openuserjs.org/scripts/choflojt/Imdb_Smart_Score
  function computeScore(stats) {
    let totalVotes = 0;
    let totalScore = 0;
    let numberOneVotes = 0;
    let numberTenVotes = 0;

    // Aggregate voting stats
    stats.forEach(stat => {
      const {score, votes} = stat;
      if (score == 1) {
        numberOneVotes = votes;
      } else if (score == 10) {
        numberTenVotes = votes;
      } else {
        totalVotes += votes;
        totalScore += votes * score;
      }
    });

    var factor = numberTenVotes / numberOneVotes;
    numberTenVotes -= numberOneVotes;
    if (numberTenVotes > 0) {
      numberTenVotes = parseInt(numberTenVotes * (1 - 1 / factor));
      totalVotes += numberTenVotes;
      totalScore += numberTenVotes * 10;
    } else if (numberTenVotes < 0) {
      numberOneVotes = -parseInt(numberTenVotes * (1 - factor));
      totalVotes += numberOneVotes;
      totalScore += numberOneVotes;
    }

    let roundedScore = +(Math.round((totalScore / totalVotes) * 10) / 10).toFixed(1);
    return {score: roundedScore, votes: totalVotes};
  }

  function estimateTargetAudience(scores) {
    /**
     * Account for gender skew at IMDB, as men are many times more likely to post reviews there.
     * MPAA baseline: https://web.archive.org/web/20201120002958/https://womenandhollywood.com/mpaa-report-2018-women-represent-51-of-moviegoers-47-of-ticket-buyers/
     * Incredibles 2 IMDB stats (50/50% gender neutral of moviegoers): https://www.imdb.com/title/tt3606756/ratings?ref_=tt_ov_rt
     * Estimated INDB reviewer gender distribution: Men 81%, Women 19%
     * Compensation: Number of IMDB female reviewers need to be boosted by 4.27 to be comparable to the IMDB stats for men when assessing whether or not a title is leaning towards an M/F audience.
     */
    const femaleBoostFactor = 4.27;
    const femaleVotes = scores.female.votes * femaleBoostFactor;
    const maleVotes = scores.male.votes;
    const childScore = scores.child.score;
    const totalScore = scores.total.score;

    return {
      male: maleVotes / (maleVotes + femaleVotes),
      female: femaleVotes / (maleVotes + femaleVotes),
      forChildren: (childScore / totalScore) > 1.05  // If children/teens like a title 5% more than adults, assume it's aimed at them.
    };
  }

  function updateScoreOnPage(newScore) {
    const el = assert($c('span[itemprop="ratingValue"]')[0], 'Failed to find original score on title page');
    el.innerHTML = ''+newScore;
    el.classList.add('recomputed');
  }

  function addTargetAudienceToPage(audience) {
    const parent = $c('.recomputed')[0].closest('div');
    const container = document.createElement('div');
    container.id = 'target-audience';

    function addSymbol(symbol, size, desc) {
      const el = document.createElement('span');
      el.innerHTML = symbol;
      el.setAttribute('style', `font-size: ${Math.round(size)}px;`);
      el.setAttribute('title', desc);
      container.appendChild(el);
    }

    // font-size: 28px;
    const maxSize = 30; // px;
    const minSize = 16; // px;
    const meanSize = (maxSize + minSize) / 2;
    const mfRatio = audience.male / audience.female;
    let desc;

    if (mfRatio > 3) {
      desc = 'squarely for men';
    } else if (mfRatio > 2) {
      desc = 'mostly for men';
    } else if (mfRatio > 1.2) {
      desc = 'slightly angled toward a male audience';
    } else if (1/mfRatio > 3) {
      desc = 'squarely for women';
    } else if (1/mfRatio > 2) {
      desc = 'mostly for women';
    } else if (1/mfRatio > 1.2) {
      desc = 'slightly angled toward a female audience';
    } else {
      desc = 'for both men and women alike';
    }

    // Scale symbols in relation to gender skew
    addSymbol('♂', Math.min(maxSize, Math.max(minSize, audience.male * minSize + minSize)), desc);
    addSymbol('♀', Math.min(maxSize, Math.max(minSize, audience.female * minSize + minSize)), desc);
    // Only show kid symbol when there is a childish tendency for the title
    if (audience.forChildren) addSymbol('🧒', meanSize, 'for kids, tweens or teens');

    parent.appendChild(container);
  }

  function addStyling() {
    document.head.appendChild(document.createElement('style')).innerHTML = `
      .recomputed { color: #ffde5c; }
      #target-audience {
        position: absolute;
        margin-top: 18px;
        cursor: help;
        margin-left: 71px;
      }
    `;
  }

  async function main() {
    addStyling();
    log('Recomputing title score');

    // Fetch all rating pages in parallel
    const scores = await cache('normscore|' + ratingURL, async () => {
      const [total, female, male, child] = await Promise.all(
        [ratingURL, femaleRatingURL, maleRatingURL, childRatingURL]
          .map(url => fetchDoc(url).then(extractVoteStats).then(computeScore)));
      return {total, female, male, child};
    });

    updateScoreOnPage(scores.total.score);
    addTargetAudienceToPage(estimateTargetAudience(scores));
  }

  main();

})();