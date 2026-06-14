library(plumber)

pr <- pr()
pr <- pr_filter(pr, "test", function(req, res) {
  cat("Before forward\n")
  plumber::forward()
  cat("After forward\n")
})
pr <- pr_get(pr, "/test", function() {
  cat("In endpoint\n")
  return(list(status="ok"))
})

# Start server in background
cat("Starting server\n")
# We'll just run it with run_command and test using curl.
