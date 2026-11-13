const task = await taskSpace("xprobe 工作台改版视觉验收");
const page = task.page("p1");
await page.goto("file:///D:/code/yunxiao/x-observe-probe/tmp-ui/preview.html");
await page.waitForLoadState("load");
const path = await page.screenshot({ path: "D:/code/yunxiao/x-observe-probe/tmp-ui/after.png", fullPage: true });
console.log("shot:", path);
console.log("title:", await page.title());
