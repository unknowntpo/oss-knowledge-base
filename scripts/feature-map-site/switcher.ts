/**
 * The page's only script (Spec 020 Behavior 8): fills the ref switcher from the site's
 * `versions.json` and opens the chosen ref's page. The page is complete without it; when the list
 * cannot be loaded or is not the expected shape, the select keeps the current ref and a notice says
 * so. Plain ES5-style JavaScript, inlined into every page; it uses `document` and `window` only, so
 * the unit tests run it against fakes.
 */
export const switcherScript = `(function () {
  var select = document.getElementById("ref-select");
  var note = document.getElementById("ref-note");
  if (!select || !note) return;
  var current = select.getAttribute("data-current");
  var groups = [["branch", "分支"], ["tag", "標籤"]];
  var suffix = { "no-feature-map": "（沒有 feature map）", "error": "（無法產生）" };
  function say(text) { note.textContent = text; note.hidden = false; }
  function fill(versions) {
    if (!versions || !Array.isArray(versions.refs) || versions.refs.length === 0) throw new Error("shape");
    var built = [];
    var listed = false;
    groups.forEach(function (group) {
      var box = document.createElement("optgroup");
      box.label = group[1];
      versions.refs.forEach(function (ref) {
        if (!ref || typeof ref.name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(ref.slug)) throw new Error("shape");
        if (ref.kind !== group[0]) return;
        var option = document.createElement("option");
        option.value = ref.slug;
        if (ref.slug === current) listed = true;
        option.textContent = ref.name + (suffix[ref.status] || "");
        box.appendChild(option);
      });
      if (box.children.length > 0) built.push(box);
    });
    if (built.length === 0) throw new Error("shape");
    if (!listed) {
      // A page kept by a cache after its ref left the list: keep it selectable.
      var own = document.createElement("option");
      own.value = current;
      own.textContent = current;
      built.unshift(own);
    }
    select.replaceChildren.apply(select, built);
    select.value = current;
    var at = typeof versions.builtAt === "string" && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}/.test(versions.builtAt)
      ? versions.builtAt.slice(0, 10) + " " + versions.builtAt.slice(11, 16) + " UTC" : "";
    if (at) say("網站建置於 " + at);
  }
  select.addEventListener("change", function () {
    var slug = select.value;
    if (slug === current || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) return;
    window.location.assign("../" + slug + "/" + (window.location.hash || ""));
  });
  try {
    window.fetch("../versions.json", { cache: "no-cache" })
      .then(function (response) { if (!response.ok) throw new Error("http"); return response.json(); })
      .then(fill)
      .catch(function () { say("無法載入版本清單，只顯示目前版本"); });
  } catch (error) {
    say("無法載入版本清單，只顯示目前版本");
  }
})();`;
