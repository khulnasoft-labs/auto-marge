import {
  createPullRequestInfo,
  approvedReview,
  successCheckRun,
  queuedCheckRun,
  createGithubApi,
  createEmptyLogger,
  createGithubApiFromPullRequestInfo,
  createApplication,
  createPullRequestOpenedEvent,
  createGetContents,
  createCheckSuiteCompletedEvent,
  createCheckRunCreatedEvent,
  createCommitsWithCheckSuiteWithCheckRun,
  createPullRequestQuery,
  createStatusEvent,
  createOkResponse,
  GraphqlError
} from './mock'
import { immediate } from '../src/delay'
import appFn from '../src/index'
import { CommentAuthorAssociation } from '../src/models'
import { GitHubAPI } from 'probot/lib/github'

it('full happy path', async () => {
  const config = `
  minApprovals:
    OWNER: 1
  `

  const pullRequestInfo = createPullRequestInfo({
    reviews: {
      nodes: [
        approvedReview({
          authorAssociation: CommentAuthorAssociation.OWNER
        })
      ]
    },
    commits: createCommitsWithCheckSuiteWithCheckRun({
      checkRun: successCheckRun
    })
  })

  const github = createGithubApiFromPullRequestInfo({
    pullRequestInfo,
    config
  })

  const app = createApplication({
    appFn,
    logger: createEmptyLogger(),
    github
  })

  await app.receive(
    createPullRequestOpenedEvent({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      number: 1
    })
  )

  expect(github.pulls.merge).toHaveBeenCalled()
})

it('not enough approval reviews', async () => {
  const config = `
  minApprovals:
    OWNER: 1
  `

  const pullRequestInfo = createPullRequestInfo({
    reviews: {
      nodes: [
      ]
    },
    commits: createCommitsWithCheckSuiteWithCheckRun({
      checkRun: successCheckRun
    })
  })

  const github = createGithubApiFromPullRequestInfo({
    pullRequestInfo,
    config
  })

  const app = createApplication({
    appFn,
    logger: createEmptyLogger(),
    github
  })

  await app.receive(
    createPullRequestOpenedEvent({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      number: 1
    })
  )

  await app.receive(
    createCheckRunCreatedEvent({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      number: 1
    })
  )

  expect(github.pulls.merge).not.toHaveBeenCalled()

  pullRequestInfo.reviews.nodes = [
    approvedReview({
      authorAssociation: CommentAuthorAssociation.OWNER
    })
  ]

  await app.receive(
    createCheckSuiteCompletedEvent({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      number: 1
    })
  )

  expect(github.pulls.merge).toHaveBeenCalled()
})

it('no configuration should not schedule any pull request', async () => {
  const schedulePullRequestTrigger = jest.fn()
  jest.mock('../src/pull-request-handler', () => {
    return {
      schedulePullRequestTrigger
    }
  })

  const github = createGithubApi({
    repos: {
      getContents: createGetContents({})
    }
  })

  const app = createApplication({
    appFn,
    logger: createEmptyLogger(),
    github
  })

  app.receive(
    createPullRequestOpenedEvent({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      number: 1
    })
  )

  expect(schedulePullRequestTrigger).toBeCalledTimes(0)
})

it('merges when receiving status event', async () => {
  const config = `
  `

  const pullRequestInfo = createPullRequestInfo({
    reviews: {
      nodes: [
        approvedReview({
          authorAssociation: CommentAuthorAssociation.OWNER
        })
      ]
    },
    commits: createCommitsWithCheckSuiteWithCheckRun({
      checkRun: successCheckRun
    })
  })

  const github = createGithubApiFromPullRequestInfo({
    pullRequestInfo,
    config
  })

  const graphql = jest.fn(async (query, variables) => github.graphql(query, variables))
    .mockResolvedValueOnce({
      repository: {
        pullRequests: {
          edges: [
            {
              node: {
                number: 1,
                headRefOid: '123',
                repository: {
                  name: 'probot-auto-merge',
                  owner: {
                    login: 'khulnasoft-labs'
                  }
                }
              }
            }
          ]
        }
      }
    }) as any

  const app = createApplication({
    appFn,
    logger: createEmptyLogger(),
    github: {
      ...github,
      graphql
    } as GitHubAPI
  })

  await app.receive(
    createStatusEvent({
      owner: 'owner-of-fork',
      repo: 'probot-auto-merge',
      sha: '123',
      branchName: 'pr-1'
    })
  )

  await immediate()

  expect(graphql).toHaveBeenCalledWith(
    expect.anything(), expect.objectContaining({
      owner: 'owner-of-fork',
      repo: 'probot-auto-merge'
    })
  )
  expect(graphql).toHaveBeenCalledWith(
    expect.anything(), expect.objectContaining({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      pullRequestNumber: 1
    })
  )
  expect(github.pulls.merge).toHaveBeenCalledWith({
    merge_method: 'merge',
    pull_number: 1,
    owner: 'khulnasoft-labs',
    repo: 'probot-auto-merge'
  })
})

it('pending check run', async () => {
  jest.useFakeTimers()
  const config = `
  minApprovals:
    OWNER: 1
  `

  const pullRequestInfo = createPullRequestInfo({
    reviews: {
      nodes: [
        approvedReview({
          authorAssociation: CommentAuthorAssociation.OWNER
        })
      ]
    },
    commits: createCommitsWithCheckSuiteWithCheckRun({
      checkRun: queuedCheckRun
    })
  })

  const github = createGithubApiFromPullRequestInfo({
    pullRequestInfo,
    config
  })

  const app = createApplication({
    appFn,
    logger: createEmptyLogger(),
    github
  })

  await app.receive(
    createPullRequestOpenedEvent({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      number: 1
    })
  )

  await immediate()

  expect(github.graphql).toHaveBeenCalled()
  expect(setTimeout).toHaveBeenCalled()
  expect(github.pulls.merge).not.toHaveBeenCalled()
  github.graphql = jest.fn(async () => {
    return {
      repository: {
        pullRequest: {
          ...pullRequestInfo,
          commits: createCommitsWithCheckSuiteWithCheckRun({
            checkRun: successCheckRun
          })
        }
      }
    } as any
  })
  jest.runAllTimers()
  await immediate()
  expect(github.graphql).toHaveBeenCalled()
  expect(github.pulls.merge).toHaveBeenCalled()
})

it('to merge when one rule and the global configuration passes', async () => {
  const config = `
    rules:
    - minApprovals:
        OWNER: 1
    - requiredLabels:
      - merge
  `

  const pullRequestInfo = createPullRequestInfo({
    reviews: {
      nodes: [
        approvedReview({
          authorAssociation: CommentAuthorAssociation.CONTRIBUTOR
        })
      ]
    },
    commits: createCommitsWithCheckSuiteWithCheckRun({
      checkRun: successCheckRun
    }),
    labels: {
      nodes: [
        { name: 'merge' }
      ]
    }
  })

  const github = createGithubApiFromPullRequestInfo({
    pullRequestInfo,
    config
  })

  const app = createApplication({
    appFn,
    logger: createEmptyLogger(),
    github
  })

  await app.receive(
    createPullRequestOpenedEvent({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      number: 1
    })
  )

  expect(github.pulls.merge).toHaveBeenCalled()
})

it('to merge when the role of the pull request author is satisfied, and fail otherwise', async () => {
  const config = `
    rules:
    - requiredAuthorRole: OWNER
      minApprovals:
        OWNER: 1
  `

  const pullRequestInfo = createPullRequestInfo({
    authorAssociation: CommentAuthorAssociation.MEMBER,
    reviews: {
      nodes: [
        approvedReview({
          authorAssociation: CommentAuthorAssociation.OWNER
        })
      ]
    },
    commits: createCommitsWithCheckSuiteWithCheckRun({
      checkRun: successCheckRun
    })
  })

  const github = createGithubApiFromPullRequestInfo({
    pullRequestInfo,
    config
  })

  const app = createApplication({
    appFn,
    logger: createEmptyLogger(),
    github
  })

  await app.receive(
    createPullRequestOpenedEvent({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      number: 1
    })
  )

  // Only 1 review and PR is not from OWNER
  expect(github.pulls.merge).not.toHaveBeenCalled()

  pullRequestInfo.authorAssociation = CommentAuthorAssociation.OWNER

  await app.receive(
    createPullRequestOpenedEvent({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      number: 2
    })
  )

  // Only 1 review but PR is from OWNER
  expect(github.pulls.merge).toHaveBeenCalled()
})

it('to report error when processing pull request results in error', async () => {
  const Raven = require('raven')
  const captureException = jest.fn()
  Raven.captureException = captureException
  const consoleError = jest.fn()
  console.error = consoleError

  const github = createGithubApi({
    repos: {
      getContents: createGetContents({
        '.github/auto-merge.yml': () => Buffer.from('')
      })
    },
    query: jest.fn(async () => {
      throw new Error('Something went wrong')
    })
  })

  const app = createApplication({
    appFn,
    logger: createEmptyLogger(),
    github
  })

  await app.receive(
    createPullRequestOpenedEvent({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      number: 1
    })
  )

  expect(captureException).toHaveBeenCalled()
  expect(consoleError).toHaveBeenCalled()
})

it('to report error and continue when graphql query contained errors', async () => {
  const Raven = require('raven')
  const captureException = jest.fn()
  Raven.captureException = captureException
  const consoleError = jest.fn()
  console.error = consoleError

  const config = `
  minApprovals:
    OWNER: 1
  `

  const pullRequestInfo = createPullRequestInfo({
    reviews: {
      nodes: [
        approvedReview({
          authorAssociation: CommentAuthorAssociation.OWNER
        })
      ]
    },
    commits: createCommitsWithCheckSuiteWithCheckRun({
      checkRun: successCheckRun
    })
  })

  const pullRequestQuery = createPullRequestQuery(pullRequestInfo)

  const github = createGithubApi({
    repos: {
      getContents: createGetContents({
        '.github/auto-merge.yml': () => Buffer.from(config)
      })
    },
    pulls: {
      merge: createOkResponse()
    },
    graphql: jest.fn(async () => {
      throw new GraphqlError({
        errors: [{
          message: 'Some problem'
        }],
        data: pullRequestQuery
      })
    })
  })

  const app = createApplication({
    appFn,
    logger: createEmptyLogger(),
    github
  })

  await app.receive(
    createPullRequestOpenedEvent({
      owner: 'khulnasoft-labs',
      repo: 'probot-auto-merge',
      number: 1
    })
  )

  expect(captureException).toHaveBeenCalledTimes(1)
  expect(github.pulls.merge).toHaveBeenCalled()
})

it('when no permission to source repository throw a no permission error', async () => {
  const Raven = require('raven')
  const captureException = jest.fn()
  Raven.captureException = captureException

  const config = `
  minApprovals:
    OWNER: 1
  `

  const pullRequestInfo = createPullRequestInfo({
    headRef: undefined,
    mergeable: undefined
  })

  const github = createGithubApiFromPullRequestInfo({
    pullRequestInfo,
    config
  })

  const app = createApplication({
    appFn,
    logger: createEmptyLogger(),
    github
  })

  await app.receive(
    createPullRequestOpenedEvent({
      owner: pullRequestInfo.baseRef.repository.owner.login,
      repo: pullRequestInfo.baseRef.repository.name,
      number: 1
    })
  )

  expect(captureException).toHaveBeenCalled()
  expect(captureException.mock.calls[0][0].message).toContain('No permission')
})
