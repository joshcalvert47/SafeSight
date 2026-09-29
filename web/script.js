(() => {
    "use strict";

    /* Mobile nav */
    const toggle = document.getElementById("nav-toggle");
    const nav = document.getElementById("site-nav");

    if (toggle && nav) {
        const setOpen = (open) => {
            toggle.setAttribute("aria-expanded", String(open));
            toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
            nav.classList.toggle("is-open", open);
            document.body.classList.toggle("nav-open", open);
        };

        toggle.addEventListener("click", () => {
            setOpen(toggle.getAttribute("aria-expanded") !== "true");
        });

        nav.addEventListener("click", (e) => {
            if (e.target.closest("a")) setOpen(false);
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") setOpen(false);
        });
    }

    /* Scroll reveal */
    const revealEls = document.querySelectorAll(".reveal");
    if ("IntersectionObserver" in window && revealEls.length) {
        const io = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        entry.target.classList.add("is-visible");
                        io.unobserve(entry.target);
                    }
                }
            },
            { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
        );
        revealEls.forEach((el) => io.observe(el));
    } else {
        revealEls.forEach((el) => el.classList.add("is-visible"));
    }

    /* Only one FAQ item open at a time */
    const faqs = document.querySelectorAll(".faq details");
    faqs.forEach((d) => {
        d.addEventListener("toggle", () => {
            if (d.open) faqs.forEach((o) => o !== d && (o.open = false));
        });
    });

    /* Footer year */
    const year = document.getElementById("year");
    if (year) year.textContent = String(new Date().getFullYear());
})();
