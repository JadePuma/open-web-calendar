Feature: Mobile calendar view

  Scenario: Desktop viewport shows scheduler
    Given we add the calendar "one-event"
     When we set the viewport to 1024x768
      And we look at 2019-03-04
     Then the element ".dhx_cal_data" is visible
      And the body does not have class "owc-mobile-active"

  Scenario: Mobile viewport shows compact shell with events
    Given we add the calendar "one-event"
     When we set the viewport to 360x800
      And we look at 2019-03-04
     Then the element "#owc-mobile-shell" is visible
      And the body has class "owc-mobile-active"
      And we can see the text "test1"

  Scenario: Mobile viewport empty day shows empty state
    Given we add the calendar "one-event"
     When we set the viewport to 360x800
      And we look at 2019-03-04
      And we click the element '[data-owc-action="select-day"][data-owc-date="2019-03-05"]'
     Then the element ".owc-mobile-empty-state" is visible

  Scenario: Mobile viewport event tap opens modal
    Given we add the calendar "one-event"
     When we set the viewport to 360x800
      And we look at 2019-03-04
      And we click the element ".owc-mobile-day-list-item"
     Then the element ".owc-mobile-event-modal" is visible
      And we can see the text "test1"

  Scenario: Mobile viewport controls respect specification
    Given we add the calendar "one-event"
      And we set the "controls" parameter to ["next","date"]
     When we set the viewport to 360x800
      And we look at 2019-03-04
     Then the element '[data-owc-action="next-month"]' is visible
      And the element '[data-owc-action="prev-month"]' is not visible
      And the element '[data-owc-action="today"]' is not visible

  Scenario: Agenda default tab regression
    Given we add the calendar "one-event"
     When we set the viewport to 1024x768
      And we look at 2024-01-18
     Then we can see the text "AGENDA"
     When we set the "tabs" parameter to ["month","week","day"]
      And we look at 2024-01-18
     Then we cannot see the text "AGENDA"
